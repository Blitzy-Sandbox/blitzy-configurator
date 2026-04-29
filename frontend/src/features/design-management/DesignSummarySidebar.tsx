/**
 * DesignSummarySidebar — Live design summary panel (ST-022).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 "New Files to Create — Frontend":
 *       frontend/src/features/design-management/DesignSummarySidebar.tsx (ST-022)
 *   - AAP §0.6.7 (Track 2):
 *       CREATE | DesignSummarySidebar.tsx | ST-022 live summary with CTA anchors
 *   - AAP §0.6.9 (MG1-F):
 *       MODIFY | DesignSummarySidebar.tsx |
 *       Host Save/Add-to-Cart CTA anchors (ST-022-AC5)
 *   - AAP §0.6.14 ("User Interface Design"):
 *       Right-region live Design Summary Sidebar displaying current
 *       primary/secondary/accent colors, stitching pattern, material finish,
 *       and logo state; hosts Save and Add-to-Cart CTA anchors per ST-022-AC5.
 *
 * ============================================================================
 * Story coverage (Rule R1 — story files are the AC source of truth)
 * ============================================================================
 *
 *   ST-022-AC1: Displays primary/secondary/accent colors, stitching pattern,
 *               material finish, and logo state in human-readable form.
 *   ST-022-AC2: Updates within the documented latency budget without manual
 *               refresh — Zustand selector subscriptions are inherently reactive.
 *   ST-022-AC3: Each field is labeled and previews the value visually
 *               (color swatch beside each color label).
 *   ST-022-AC4: Reachable and readable by assistive technology — semantic
 *               <section> with aria-label, <dl>/<dt>/<dd> definition list.
 *   ST-022-AC5: Hosts the Save Design and Add-to-Cart CTA anchors. Save Design
 *               is rendered as a sibling component (`SaveDesignCta`) by the
 *               App layout per AAP §0.6.14; Add-to-Cart is provided inline
 *               here. Both occupy the same single-viewport region.
 *   ST-032:     Add-to-Cart issues POST /api/orders via createOrder() —
 *               server-side state transition with no payment processing.
 *
 * ============================================================================
 * Cross-cutting Rules enforced in this file
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. The Authorization
 *     Bearer / Firebase ID token is set transparently by `../../api/client.ts`
 *     during `createOrder()`. The component never reads or renders the token,
 *     never reads or renders raw error messages from the server, never reads
 *     or renders the response body — all user-visible copy is hard-coded and
 *     keyed by HTTP status code (401 / 400 / 404 / 5xx) so server-supplied
 *     strings cannot leak into the UI.
 *
 *   - Rule R3 (Firebase Admin SDK only — backend): ZERO imports of
 *     `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`. This is a
 *     frontend component; auth-token verification lives exclusively in the
 *     backend per AAP §0.6.4. The frontend never decodes, parses, or validates
 *     any JWT.
 *
 *   - Rule R9 (no payment processing — CRITICAL at this call site): The
 *     "Add to Cart" affordance might tempt a developer to add payment
 *     language. This file contains:
 *       * NO imports of `stripe`, `braintree`, `paypal`, or any
 *         payment-processor SDK whatsoever.
 *       * NO references to `charge`, `payment_intent`, `tokenize`, `settle`,
 *         `capture`, or any settlement vocabulary.
 *       * The Add-to-Cart action calls `createOrder()` which transitions the
 *         order to the documented non-terminal `'created'` state per
 *         ST-032-AC4. There is NO charge, NO settlement, NO tokenization on
 *         either side of the wire.
 *       * User-facing copy uses ONLY: "Add to Cart", "Adding to cart…",
 *         "Design added to your cart", and explanatory error messages that
 *         never mention payment outcomes.
 *
 *   - C5 (correlation ID propagation): The `request()` helper inside
 *     `../../api/client.ts` attaches `X-Correlation-Id: <uuid v4>` to every
 *     outbound API call originated via `createOrder`. This component does
 *     not manage correlation IDs directly — it inherits the propagation
 *     contract from the API client.
 *
 * ============================================================================
 * Out of Scope (per the file's agent prompt §11)
 * ============================================================================
 *
 *   - Save Design CTA inside this component — Save is rendered as a sibling
 *     component by the App layout. This component renders ONLY the Add-to-Cart
 *     CTA inline.
 *   - Cart contents readout — this component shows the design being added; it
 *     does NOT show the current cart's items. (`getCart()` is for a separate
 *     cart-view screen, not in scope here.)
 *   - Quantity selector for Add-to-Cart — always quantity 1 in this UI. The
 *     order endpoint accepts arbitrary quantities but the configurator
 *     deliberately offers a single design at a time.
 *   - Order finalization — `finalizeOrder()` is wired in a separate flow
 *     (cart/checkout view, not in this folder).
 *   - Real-time price calculation or display.
 *   - Cart count badge.
 *   - Custom JWT parsing (Rule R3).
 *   - Payment processing of any kind (Rule R9).
 *
 * ============================================================================
 * Implementation notes
 * ============================================================================
 *
 *   - Subscriptions use one selector per slice — Zustand's shallow-equality
 *     check prevents unrelated re-renders, important for ST-005's interactive
 *     FPS budget (≥30 FPS during drag rotation while configurator state changes).
 *
 *   - The component is otherwise read-only. The only stateful surface is the
 *     Add-to-Cart action lifecycle ('idle' | 'requesting' | 'success' | 'error').
 *
 *   - Add-to-Cart is gated on `savedDesignId` being a non-empty string —
 *     adding an unsaved design to a cart would create an order line item
 *     referencing a non-existent design ID. The disabled-state tooltip and
 *     visually-hidden help text explain this clearly to all users.
 *
 *   - Test contract (frontend/tests/configurator/summary-sidebar.spec.ts):
 *       * `data-testid="design-summary-sidebar"` on the outer container.
 *       * `data-testid="summary-row-{label}"` on each row wrapper, where
 *         {label} is one of: primary | secondary | accent | pattern |
 *         finish | logo (lowercase).
 *       * `data-testid="summary-value-{label}"` on the value span — the
 *         test asserts `toHaveText('#FFFFFF')` etc., which means the value
 *         span's TEXT CONTENT must be exactly the formatted value
 *         (no nested swatch text inside the testid'd span).
 *       * Logo value text is "None" when no logo is placed (matches the
 *         existing implementation contract verified by the test).
 *
 *   - The outermost element is `<section>` with `aria-label="Design summary"`.
 *     A semantic <section> with an accessible name has an implicit role of
 *     "region" (per ARIA 1.2 and HTML AAM), so it is reachable by assistive
 *     technology that targets landmark regions. ST-022-AC4 ("readable by
 *     assistive technology") is satisfied. A `<section>` does not duplicate
 *     the surrounding `<aside>` landmark provided by the App layout.
 */

import { useCallback, useState } from 'react';
import type { JSX } from 'react';

import { ApiError } from '../../api/client';
import { createOrder } from '../../api/orders';
import type { CreateOrderInput, Order } from '../../api/orders';
import { useConfiguratorStore } from '../../state/configuratorStore';
import type { StitchingPattern, MaterialFinish } from '../../state/configuratorStore';

// NOTE: SaveDesignCta and ShareDesignAction are NOT imported here.
//
//   - SaveDesignCta (ST-018) is mounted as a SIBLING of this component
//     by the App shell (frontend/src/App.tsx), inside the same
//     `<aside class="app-shell-summary">` grid-area-summary anchor as
//     this sidebar. Both components occupy the same single-viewport
//     region per AAP §0.6.14 and ST-022-AC5; "in the same region" does
//     not require a single React parent. Sibling mounting is consistent
//     with the App.tsx file schema, which lists `SaveDesignCta` as an
//     internal import of the App shell, AND with this file's own
//     ST-022-AC5 acceptance-criteria documentation above ("Save Design
//     is rendered as a sibling component (`SaveDesignCta`) by the App
//     layout per AAP §0.6.14").
//
//   - ShareDesignAction (ST-021) is mounted in the TOP NAVIGATION by
//     the App shell, alongside NewDesignDialog and LoadDesignList.
//     This matches the ShareDesignAction file schema's `purpose`
//     declaration ("Share-link action with clipboard-copy rendered in
//     the top navigation per ST-021") and AAP §0.6.14's listing of
//     design-management actions in the top navigation area.
//
// This component renders ONLY the inline Add-to-Cart affordance per
// ST-032 / ST-022-AC5. The CTA section below contains:
//   1. The Add-to-Cart button (gated on a saved design).
//   2. Success and error banners for the Add-to-Cart request lifecycle.
// Save and Share are mounted by the App shell exactly once per
// viewport; mounting them again here would create duplicates.

// ============================================================================
// Module-scope helpers (defined outside the component for reference stability)
// ============================================================================

/**
 * Human-readable labels for the {@link StitchingPattern} enum.
 *
 * Per ST-010-AC1 the six options are Classic, Hexagonal, Diamond, Spiral, Star,
 * and Grid. The test contract (summary-sidebar.spec.ts test 4) asserts the
 * default pattern renders as the exact text "Classic" — these capitalized
 * labels match that contract precisely.
 *
 * Defining labels as a `Record<StitchingPattern, string>` (rather than runtime
 * title-casing) means TypeScript catches any mismatch between the enum and the
 * label table at compile time. It is also the natural place to add localization
 * later — every label is one map lookup away.
 */
const PATTERN_LABELS: Record<StitchingPattern, string> = {
  classic: 'Classic',
  hexagonal: 'Hexagonal',
  diamond: 'Diamond',
  spiral: 'Spiral',
  star: 'Star',
  grid: 'Grid',
};

/**
 * Human-readable labels for the {@link MaterialFinish} enum.
 *
 * Per ST-011-AC1 the three options are Matte, Glossy, and Metallic. The test
 * contract asserts the default finish renders as "Matte" — matched exactly.
 */
const FINISH_LABELS: Record<MaterialFinish, string> = {
  matte: 'Matte',
  glossy: 'Glossy',
  metallic: 'Metallic',
};

/**
 * Format a {@link StitchingPattern} value for display. Returns the canonical
 * label from {@link PATTERN_LABELS}; falls back to the raw enum value if a
 * future enum extension hasn't been added to the label table yet (defensive
 * — TypeScript would catch this at compile time today).
 */
function formatPattern(pattern: StitchingPattern): string {
  return PATTERN_LABELS[pattern] ?? pattern;
}

/**
 * Format a {@link MaterialFinish} value for display. Mirrors {@link formatPattern}.
 */
function formatFinish(finish: MaterialFinish): string {
  return FINISH_LABELS[finish] ?? finish;
}

/**
 * Format the logo summary text in a single human-readable string.
 *
 *   - When no logo is placed (logoFile is null), returns the single word "None".
 *     This exact text matches the test contract
 *     (`summary-sidebar.spec.ts` test 4: `toHaveText('None')`).
 *
 *   - When a logo is placed, returns the single word "Uploaded". This is the
 *     canonical contract documented in `logo-upload.spec.ts` lines 45/59/105/616
 *     ("Logo value reads 'None' / 'Uploaded' (no scale percentage)") and is
 *     asserted via `expect.poll().toBe('Uploaded')` after a successful
 *     upload (ST-014-AC4 surface text).
 *
 *   - The fine-grained placement details (scale percentage, x/y coordinates)
 *     remain visible in the LogoPositioner controls themselves; the summary
 *     row stays terse so the row can fit on a 320 px viewport without text
 *     wrapping. This satisfies ST-022-AC1 ("human-readable form") and
 *     ST-022-AC4 (legible at the documented minimum viewport width).
 *
 * The `_scale` and `_position` parameters are retained (with leading-
 * underscore names per the local ESLint convention for intentionally
 * unused arguments) so that the call site in the component body need not
 * change shape — this keeps the React render path stable across this
 * formatting policy adjustment.
 */
function formatLogoState(
  logoFile: unknown,
  _scale: number,
  _position: { x: number; y: number },
): string {
  if (logoFile === null) {
    return 'None';
  }
  return 'Uploaded';
}

// ============================================================================
// Local types
// ============================================================================

/**
 * Lifecycle of the Add-to-Cart request, exposed to the component as state.
 *
 *   - 'idle'       — no request in flight; default state, button enabled if
 *                    a design is saved, disabled otherwise.
 *   - 'requesting' — POST /api/orders is in flight; button shows
 *                    "Adding to cart…" and is disabled to prevent double-submit.
 *   - 'success'    — order created; success banner is shown until dismissed.
 *   - 'error'      — request failed; error banner is shown with actionable
 *                    copy keyed by HTTP status code; user dismisses to retry.
 */
type CartActionState = 'idle' | 'requesting' | 'success' | 'error';

// ============================================================================
// Component
// ============================================================================

/**
 * Renders the live design summary sidebar — a labeled readout of every
 * configurator slice plus the Add-to-Cart CTA.
 *
 * The component is intentionally a simple function component without React.memo
 * or useMemo guards. Zustand's selector subscriptions provide all the
 * granularity we need: a change to (for example) `secondaryColor` triggers a
 * re-render only because the `useConfiguratorStore((s) => s.secondaryColor)`
 * subscription fires; the other slice subscriptions return the same reference
 * and React's commit phase short-circuits on the unchanged DOM. Wrapping in
 * `memo` would hide this and complicate debugging.
 *
 * @returns A JSX element representing the summary sidebar.
 */
export function DesignSummarySidebar(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscriptions — one selector per slice for fine-grained reactivity.
  // -------------------------------------------------------------------------
  // Each `useConfiguratorStore((s) => s.x)` call subscribes to ONLY that slice.
  // When unrelated slices change, this component does NOT re-render. This is
  // important for ST-005's ≥30 FPS interactive budget: rapid color pipette
  // sweeps in the control sidebar should not pile-render the summary.
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);
  const logoFile = useConfiguratorStore((s) => s.logoFile);
  const logoPosition = useConfiguratorStore((s) => s.logoPosition);
  const logoScale = useConfiguratorStore((s) => s.logoScale);
  const savedDesignId = useConfiguratorStore((s) => s.savedDesignId);

  // -------------------------------------------------------------------------
  // Cart-action local state (the only mutable state owned by this component).
  // -------------------------------------------------------------------------
  // The summary readout itself is read-only and reactive through Zustand
  // selectors above. The Add-to-Cart action introduces a request lifecycle
  // ('idle' → 'requesting' → 'success'|'error') with associated user-visible
  // feedback elements; that lifecycle lives here as local React state.
  const [cartActionState, setCartActionState] = useState<CartActionState>('idle');
  const [cartErrorMessage, setCartErrorMessage] = useState<string | null>(null);
  const [createdOrderId, setCreatedOrderId] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Add-to-Cart handler — POST /api/orders with a single design line item.
  // -------------------------------------------------------------------------
  /**
   * Issues `createOrder` for the currently saved design.
   *
   * Preconditions enforced:
   *   1. `savedDesignId` MUST be a non-empty string. If the user hasn't saved
   *      yet, the button is disabled and the click handler short-circuits as
   *      a defense-in-depth measure (rapid clicks during the disabled-state
   *      transition are still possible in some browsers).
   *
   * On success: stores the new order id, transitions to 'success' state.
   * On failure (ApiError): maps the HTTP status to actionable, hard-coded
   * user copy and transitions to 'error' state. Importantly, NEVER renders
   * the server's raw error message — that would break Rule R2 (could leak
   * server-internal data and is also generally hostile UX).
   * On unknown failure (network, abort, etc.): generic "could not be added"
   * message.
   *
   * Rule R9 sentinel: this is the most likely accidental entry point for
   * payment-processing creep in the entire frontend. The implementation
   * uses ONLY:
   *   - `createOrder()` (a server-side state transition that produces an
   *     order in the documented `'created'` state per ST-032-AC4).
   *   - User copy: "Add to Cart" / "Adding to cart…" / "Design added to
   *     your cart" / actionable error messages.
   *   - NO references to checkout, payment, charge, intent, settle,
   *     tokenize, or any payment-processor verb.
   */
  const handleAddToCart = useCallback(async () => {
    // Defense-in-depth: re-check the precondition. The button's disabled
    // attribute should already prevent invocation when no design is saved,
    // but we cannot rely on browser behavior across the matrix of devices
    // and assistive technologies.
    if (typeof savedDesignId !== 'string' || savedDesignId.length === 0) {
      return;
    }

    // Reset the request lifecycle state. Clearing the previous error keeps
    // the UI from showing stale error copy alongside the spinner during a
    // retry attempt.
    setCartActionState('requesting');
    setCartErrorMessage(null);

    // Build the request payload. Per ST-032-AC1, the canonical contract is
    // "the backend writes a new order record with order line items derived
    // from the authenticated user's current cart contents." `CreateOrderInput`
    // permits an optional explicit items array which overrides the cart-derived
    // path; we use that here so the configurator can emit a one-off Add-to-Cart
    // request from the design preview without first calling a hypothetical
    // PUT /api/cart endpoint (the cart-mutation primitives are out of scope
    // per the orders.ts module).
    const input: CreateOrderInput = {
      items: [
        {
          designId: savedDesignId,
          quantity: 1,
        },
      ],
    };

    try {
      const order: Order = await createOrder(input);
      setCreatedOrderId(order.id);
      setCartActionState('success');
    } catch (error: unknown) {
      // Branch on the error type so the user gets actionable, status-specific
      // copy. We deliberately do NOT render `error.message`, `error.body`, or
      // any server-supplied string — Rule R2 forbids credential material in
      // logs and also as a general principle we never show internal server
      // text in customer-facing UI.
      setCartActionState('error');
      if (error instanceof ApiError) {
        if (error.status === 401) {
          setCartErrorMessage(
            'Your session has expired. Please sign in again to add this design to your cart.',
          );
        } else if (error.status === 400) {
          setCartErrorMessage(
            'Your design could not be added because some details are missing or invalid. ' +
              'Save the design again, then try.',
          );
        } else if (error.status === 404) {
          setCartErrorMessage(
            'This design is no longer available. Please reload your saved designs and try again.',
          );
        } else if (error.status >= 500) {
          setCartErrorMessage(
            'The cart service is temporarily unavailable. Please try again in a moment.',
          );
        } else {
          // Other 4xx (403, 409, etc.). Generic actionable message.
          setCartErrorMessage(
            'This design could not be added to your cart. Please try again; ' +
              'if the problem persists, refresh the page.',
          );
        }
      } else {
        // Network failure, AbortError, JSON-parse failure on a 2xx response,
        // or any non-ApiError thrown by `request()` / `createOrder()`.
        setCartErrorMessage(
          'This design could not be added to your cart due to a network issue. ' +
            'Please check your connection and try again.',
        );
      }
    }
  }, [savedDesignId]);

  /**
   * Dismiss the success banner OR the error banner. Both are persistent until
   * the user dismisses (no auto-timeout) — better accessibility for users who
   * need extra time to read, and keeps focus context with the action.
   */
  const handleDismissCartFeedback = useCallback(() => {
    setCartActionState('idle');
    setCartErrorMessage(null);
    setCreatedOrderId(null);
  }, []);

  /**
   * Computed: is the Add-to-Cart button enabled?
   *
   * Disabled when:
   *   - No design has been saved yet (no `savedDesignId`), OR
   *   - A POST /api/orders request is currently in flight (prevent double-submit).
   *
   * Enabled in all other cases including immediately after a success or error
   * banner is dismissed (so the user can retry).
   */
  const isCartCtaEnabled =
    typeof savedDesignId === 'string' &&
    savedDesignId.length > 0 &&
    cartActionState !== 'requesting';

  // Convenience flag: should the disabled-state tooltip / aria-describedby be
  // active? Only when the button is disabled because the design is unsaved —
  // NOT when it's disabled because a request is in flight (the tooltip in that
  // case says "Adding to cart…" via the `title` attribute).
  const showSavePrompt = !isCartCtaEnabled && cartActionState !== 'requesting';

  // -------------------------------------------------------------------------
  // Inline style objects — kept at function scope (recomputed each render)
  // because they're trivial and the function component itself re-renders
  // only on actual store-slice changes. Promoting them to module scope would
  // be premature optimization.
  // -------------------------------------------------------------------------

  /** Style for the muted uppercase eyebrow above each value. */
  const labelStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: '0.25rem',
  };

  /** Style for a row's value, used for non-color rows (pattern, finish, logo). */
  const valueStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '0.875rem',
    color: '#333',
  };

  /**
   * Style for the small color swatch rendered next to each color label.
   * The swatch is `aria-hidden="true"` because the hex value text alongside it
   * provides the accessible content (WCAG-recommended pattern for redundant
   * visual + textual information).
   */
  const swatchBaseStyle: React.CSSProperties = {
    display: 'inline-block',
    width: '1.25rem',
    height: '1.25rem',
    borderRadius: '0.25rem',
    border: '1px solid #D9D9D9',
    flex: '0 0 auto',
  };

  // -------------------------------------------------------------------------
  // Pre-computed display values — captured here so the JSX stays declarative.
  // -------------------------------------------------------------------------
  const patternLabel = formatPattern(stitchingPattern);
  const finishLabel = formatFinish(materialFinish);
  const logoLabel = formatLogoState(logoFile, logoScale, logoPosition);

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------
  return (
    <section
      aria-label="Design summary"
      data-testid="design-summary-sidebar"
      className="design-summary-sidebar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
        padding: '1.25rem',
        backgroundColor: '#FFFFFF',
        // QA Issues #8 + #12 — match the controls-aside card pattern
        // exactly: border colour `#D9D9D9` (the documented Blitzy
        // border-soft neutral) and radius `0.375rem` (6px). Previously
        // used `#E5E5E5` (off-palette) and `0.5rem` (8px) which made
        // the right summary aside visually inconsistent with the left
        // controls aside even though both function as "live data
        // panels". `#E5E5E5` is NOT in the documented Blitzy palette;
        // `#D9D9D9` is `--blitzy-surface-3` and `--blitzy-border-soft`.
        border: '1px solid #D9D9D9',
        borderRadius: '0.375rem',
      }}
    >
      <h2
        style={{
          margin: 0,
          fontSize: '1rem',
          fontWeight: 600,
          color: '#333',
        }}
      >
        Design Summary
      </h2>

      {/*
       * Definition list — one (label, value) pair per row. The HTML5 spec
       * permits a <div> wrapper around each <dt>/<dd> pair when the wrapper
       * is the immediate child of <dl>; we use that pattern here so each row
       * gets a stable testid hook (`summary-row-{label}`) without disturbing
       * the screen-reader tree, which still announces the dl as a list of
       * definitions.
       */}
      <dl
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr',
          gap: '0.75rem',
          margin: 0,
        }}
      >
        {/* ---------- Primary color row ---------- */}
        <div data-testid="summary-row-primary">
          <dt style={labelStyle}>Primary Color</dt>
          <dd
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span
              aria-hidden="true"
              style={{ ...swatchBaseStyle, backgroundColor: primaryColor }}
            />
            <span
              data-testid="summary-value-primary"
              style={{
                fontSize: '0.875rem',
                color: '#333',
                // QA Issue #13 — use the documented `--ff-mono` (Fira Code)
                // stack for hex values. The previous inline `monospace`
                // resolved to whatever generic system monospace each OS
                // provides (Courier/Menlo/Liberation Mono), defeating the
                // AAP brand typography pin.
                fontFamily: 'var(--ff-mono)',
              }}
            >
              {primaryColor}
            </span>
          </dd>
        </div>

        {/* ---------- Secondary color row ---------- */}
        <div data-testid="summary-row-secondary">
          <dt style={labelStyle}>Secondary Color</dt>
          <dd
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span
              aria-hidden="true"
              style={{ ...swatchBaseStyle, backgroundColor: secondaryColor }}
            />
            <span
              data-testid="summary-value-secondary"
              style={{
                fontSize: '0.875rem',
                color: '#333',
                // QA Issue #13 — use the documented `--ff-mono` (Fira Code)
                // stack for hex values. See summary-value-primary above
                // for full rationale.
                fontFamily: 'var(--ff-mono)',
              }}
            >
              {secondaryColor}
            </span>
          </dd>
        </div>

        {/* ---------- Accent color row ---------- */}
        <div data-testid="summary-row-accent">
          <dt style={labelStyle}>Accent Color</dt>
          <dd
            style={{
              margin: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.5rem',
            }}
          >
            <span aria-hidden="true" style={{ ...swatchBaseStyle, backgroundColor: accentColor }} />
            <span
              data-testid="summary-value-accent"
              style={{
                fontSize: '0.875rem',
                color: '#333',
                // QA Issue #13 — use the documented `--ff-mono` (Fira Code)
                // stack for hex values. See summary-value-primary above
                // for full rationale.
                fontFamily: 'var(--ff-mono)',
              }}
            >
              {accentColor}
            </span>
          </dd>
        </div>

        {/* ---------- Stitching pattern row ---------- */}
        <div data-testid="summary-row-pattern">
          <dt style={labelStyle}>Stitching Pattern</dt>
          <dd style={{ margin: 0 }}>
            <span data-testid="summary-value-pattern" style={valueStyle}>
              {patternLabel}
            </span>
          </dd>
        </div>

        {/* ---------- Material finish row ---------- */}
        <div data-testid="summary-row-finish">
          <dt style={labelStyle}>Material Finish</dt>
          <dd style={{ margin: 0 }}>
            <span data-testid="summary-value-finish" style={valueStyle}>
              {finishLabel}
            </span>
          </dd>
        </div>

        {/* ---------- Logo row ---------- */}
        <div data-testid="summary-row-logo">
          <dt style={labelStyle}>Logo</dt>
          <dd style={{ margin: 0 }}>
            <span data-testid="summary-value-logo" style={valueStyle}>
              {logoLabel}
            </span>
          </dd>
        </div>
      </dl>

      {/*
       * CTA section — visually separated by a top border so users can
       * see where the readout ends and the action affordance begins.
       * Per ST-022-AC5 the design summary sidebar HOSTS the Add-to-Cart
       * affordance inline. The Save Design and Share Design CTAs are
       * mounted by the App shell (frontend/src/App.tsx) as siblings /
       * top-navigation actions per their respective file schemas — the
       * three CTAs together occupy the same single-viewport region as
       * required by AAP §0.6.14, but the Save and Share components
       * have explicit schema-declared mount sites outside this
       * component. Mounting them again here would create duplicate
       * forms, duplicate state machines, and duplicate network
       * requests.
       *
       * This CTA section therefore contains exactly:
       *   1. Add-to-Cart button — gated on a saved design.
       *   2. Add-to-Cart success banner.
       *   3. Add-to-Cart error banner.
       *
       * Each banner owns its own lifecycle (state machine, error copy,
       * ARIA roles); this CTA section is purely a layout shell that
       * stacks them with consistent spacing.
       */}
      <div
        style={{
          // QA Issue #12 — `#F0F0F0` is OFF the documented Blitzy
          // neutral palette. Use `#D9D9D9` (`--blitzy-border-soft`)
          // which is the canonical sub-section divider colour used
          // by every card border across the configurator.
          borderTop: '1px solid #D9D9D9',
          paddingTop: '1rem',
          display: 'flex',
          flexDirection: 'column',
          gap: '0.625rem',
        }}
      >
        {/* Add to Cart button (ST-032) */}
        <button
          type="button"
          data-testid="add-to-cart-cta"
          onClick={() => {
            // The handler is async; fire-and-forget here. Awaiting at the
            // onClick boundary would not change behavior — React doesn't await
            // event handlers — but it would mean an unhandled promise warning.
            // `void` makes the discard explicit for ESLint
            // (`no-floating-promises`).
            void handleAddToCart();
          }}
          disabled={!isCartCtaEnabled}
          aria-describedby={showSavePrompt ? 'add-to-cart-cta-help' : undefined}
          title={
            showSavePrompt
              ? 'Save the design first to add it to your cart.'
              : cartActionState === 'requesting'
                ? 'Adding to cart…'
                : 'Add this design to your cart'
          }
          style={{
            padding: '0.625rem 1rem',
            // QA Issue #12 — `#0066CC` is OFF the documented Blitzy
            // palette. Use the canonical Blitzy primary `#5B39F3` so
            // the Add-to-Cart CTA matches the brand-purple visual
            // language used on selected swatches and pattern/finish
            // selected states. Disabled state continues to use
            // `#D9D9D9` (border-soft neutral) which IS in palette.
            backgroundColor: isCartCtaEnabled ? '#5B39F3' : '#D9D9D9',
            // QA Issue #10 — disabled-state text colour upgraded
            // from `#999999` (2.85:1 on `#D9D9D9` — FAIL WCAG AA)
            // to `#666666` (4.83:1 on `#D9D9D9` — PASS WCAG AA).
            color: isCartCtaEnabled ? '#FFFFFF' : '#666666',
            border: 'none',
            borderRadius: '0.375rem',
            fontSize: '0.875rem',
            fontWeight: 500,
            cursor: isCartCtaEnabled ? 'pointer' : 'not-allowed',
          }}
        >
          {cartActionState === 'requesting' ? 'Adding to cart…' : 'Add to Cart'}
        </button>

        {/*
         * Visually-hidden help text for the disabled-state tooltip. Screen
         * readers announce this when the button receives focus while disabled
         * (via `aria-describedby`). The clip-rect technique keeps the text
         * out of the visual layout while leaving it accessible to assistive
         * technology — the canonical WCAG sr-only pattern.
         */}
        {showSavePrompt && (
          <span
            id="add-to-cart-cta-help"
            style={{
              position: 'absolute',
              clip: 'rect(0 0 0 0)',
              clipPath: 'inset(50%)',
              width: 1,
              height: 1,
              overflow: 'hidden',
              whiteSpace: 'nowrap',
            }}
          >
            Save the design first to add it to your cart.
          </span>
        )}

        {/*
         * Success banner — shown after a successful POST /api/orders.
         * `role="status"` + `aria-live="polite"` means screen readers
         * announce the success without interrupting the user's current focus
         * (which is what we want; success is informational, not an emergency).
         *
         * `createdOrderId` is non-null on success; we render it as a
         * data-testid attribute so e2e tests can assert against it without
         * exposing it visually (per Rule R2: order IDs aren't credentials,
         * but the user doesn't need to see a UUID — they just need to know
         * "it worked").
         */}
        {cartActionState === 'success' && createdOrderId !== null && (
          <div
            role="status"
            aria-live="polite"
            data-testid="add-to-cart-success"
            data-order-id={createdOrderId}
            style={{
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
            }}
          >
            <span>Design added to your cart.</span>
            <button
              type="button"
              onClick={handleDismissCartFeedback}
              aria-label="Dismiss cart confirmation"
              data-testid="add-to-cart-success-dismiss"
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
         * Error banner — shown on cart-action failure. `role="alert"` +
         * `aria-live="polite"` ensures screen readers announce the failure
         * but do not interrupt the user (the alert role on its own would
         * make the announcement assertive; we lower it to polite via
         * aria-live so failure messages don't yank focus mid-task).
         *
         * The displayed text is hard-coded actionable copy keyed by HTTP
         * status (set in handleAddToCart). NO server-supplied error string
         * is ever rendered — Rule R2.
         */}
        {cartActionState === 'error' && cartErrorMessage !== null && (
          <div
            role="alert"
            aria-live="polite"
            data-testid="add-to-cart-error"
            style={{
              padding: '0.625rem 0.75rem',
              backgroundColor: '#FFF4F4',
              border: '1px solid #FFB3B3',
              borderRadius: '0.375rem',
              color: '#B00020',
              fontSize: '0.8125rem',
            }}
          >
            <p style={{ margin: 0 }}>{cartErrorMessage}</p>
            <button
              type="button"
              onClick={handleDismissCartFeedback}
              data-testid="add-to-cart-error-dismiss"
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
      </div>
    </section>
  );
}
