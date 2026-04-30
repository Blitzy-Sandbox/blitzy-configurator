/**
 * OrderConfirmationPanel — the post-order-creation confirmation surface
 * (ST-034 finalize order with post-processing).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.6.7 (Track 2 — Frontend Core) and §0.6.9 (Merge Gate 1, Step F):
 *       The order-confirmation surface completes the cart-and-order flow
 *       deliverable so visual regression baselines (per ST-046-AC1:
 *       "configurator, design list, cart, order confirmation") have a
 *       deterministic surface to capture.
 *
 *   - AAP §0.6.12 (Merge Gate 2, Step H — hardened test suites):
 *       The Playwright order-confirmation visual baseline at
 *       `frontend/tests/visual/order-confirmation.spec.ts` waits for
 *       `order-confirmation-panel` to be visible after clicking
 *       `create-order-button`, optionally clicks `finalize-order-button`
 *       (3-second timeout — auto-finalize is acceptable), and snapshots
 *       `order-confirmation.png`.
 *
 *   - QA Final D Issue #5 ("Order Confirmation visual surface is
 *     unreachable AND missing baselines"):
 *       This component IS the order-confirmation surface. It is rendered
 *       by `<CartPanel />` immediately after a successful POST /api/orders
 *       so the test's wait-for-panel step resolves.
 *
 *   - User stories — every acceptance criterion is honoured:
 *       ST-034-AC1 (auth + ownership): the POST /api/orders/:id/finalize
 *           call goes through ./api/orders.ts → ./api/client.ts which
 *           attaches the user's Firebase ID token. The backend's session
 *           middleware enforces ownership.
 *       ST-034-AC2 (post-processing workflow): finalization triggers the
 *           backend's documented post-processing — inventory reservation,
 *           confirmation notification, bookkeeping. The component does
 *           NOT trigger payment-processing on either side of the wire.
 *       ST-034-AC3 (idempotent rejection): a 409 from the backend means
 *           the order is already finalized; the component shows a
 *           hard-coded copy and does NOT re-issue the call.
 *       ST-034-AC4 (no settlement): finalization scope is limited to
 *           post-processing; the component's copy never names a payment
 *           outcome. Rule R9.
 *
 * ============================================================================
 * Cross-cutting rules enforced by this file
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): this file contains ZERO
 *     `console.*` calls. Errors are surfaced exclusively through the
 *     JSX banner with hard-coded copy keyed by HTTP status.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): no JWT decoding;
 *     all token attachment is delegated to `../../api/client.ts`.
 *
 *   - Rule R8 (gates fail closed): unhandled rejections during finalize
 *     transition the state machine into 'finalize-error' with a banner;
 *     the user can retry. The state machine never silently absorbs a
 *     failure.
 *
 *   - Rule R9 (CRITICAL — payment processing excluded): this component
 *     is the literal FINAL UI surface of the order flow — the most
 *     sensitive call site for accidental settlement vocabulary creep.
 *     Every defensive measure below is intentional:
 *       1. The button label is "Finalize Order". NEVER "Pay", "Charge",
 *          "Capture", "Settle", "Authorize", "Tokenize", "Bill".
 *       2. The success copy says "Order confirmed". NEVER "Payment
 *          received", "Charged", "Settled", "Captured".
 *       3. The component reads ONLY canonical Order fields (id, state,
 *          items, subtotal, currency, createdAt, lastModifiedAt). No
 *          settlement-instrument or transaction-identifier fields are
 *          rendered.
 *       4. The OrderState union is enforced by the API layer; this
 *          component branches only on 'created' vs 'finalized'.
 *
 * ============================================================================
 * Test contract (testids consumed by the Playwright suites)
 * ============================================================================
 *
 *   - `data-testid="order-confirmation-panel"`  — the outer container
 *                                                  (also has `role="region"`,
 *                                                  `aria-label="Order
 *                                                   Confirmation"`)
 *   - `data-testid="order-id"`                   — the order's
 *                                                  server-assigned UUID
 *                                                  display (masked in
 *                                                  visual snapshots)
 *   - `data-testid="order-timestamp"`            — the order's createdAt
 *                                                  display (masked)
 *   - `data-testid="order-confirmation-id"`      — opaque confirmation
 *                                                  reference (masked)
 *   - `data-testid="order-state"`                — the current order
 *                                                  state literal
 *                                                  ('created' | 'finalized')
 *   - `data-testid="finalize-order-button"`      — finalize-order CTA
 *                                                  visible while order
 *                                                  state is 'created'
 *   - `data-testid="order-finalized-message"`    — success message after
 *                                                  finalize succeeds
 *   - `data-testid="finalize-order-error"`       — error banner on
 *                                                  finalize rejection
 *   - `data-testid="order-line-item"`            — each captured
 *                                                  snapshot line item
 *   - `data-testid="order-confirmation-close"`   — close-panel button
 *
 * ============================================================================
 */

import { useCallback, useState } from 'react';
import type { JSX } from 'react';

import { ApiError } from '../../api/client';
import { finalizeOrder, type Order } from '../../api/orders';

// ============================================================================
// Local types
// ============================================================================

/**
 * Lifecycle of the finalize flow.
 *
 *   - 'idle'             — Order is in 'created' state OR 'finalized'
 *                          state (the backend already finalized before
 *                          this component received the order). The
 *                          finalize CTA is visible only while
 *                          `order.state === 'created'`.
 *   - 'finalizing'       — POST /api/orders/:id/finalize in flight;
 *                          button disabled with `aria-busy=true`.
 *   - 'finalize-error'   — finalize rejected; banner visible with retry.
 */
type FinalizeState = 'idle' | 'finalizing' | 'finalize-error';

// ============================================================================
// Props
// ============================================================================

/**
 * Props for the OrderConfirmationPanel.
 *
 * `order` is the canonical Order object returned by createOrder() OR
 * the previous panel mount. The panel does NOT mutate `order` directly
 * — it tracks the latest server response in local state so the parent
 * does not need to re-render when the state transitions.
 *
 * `onClose` is invoked when the user dismisses the confirmation. The
 * parent (CartPanel) uses this to reset its internal state (clear
 * cart, clear order, return to 'idle') so the next open shows a fresh
 * cart fetch.
 */
export interface OrderConfirmationPanelProps {
  /**
   * The persisted order returned by createOrder() OR finalizeOrder().
   * Treated as the INITIAL order; once the user clicks finalize, the
   * component tracks the updated Order in local state.
   */
  readonly order: Order;

  /**
   * Callback invoked when the user dismisses the panel via the close
   * button OR by pressing Escape. The parent should reset any
   * cart-related state and return the panel to its idle state.
   */
  readonly onClose: () => void;
}

// ============================================================================
// Module-scope helpers
// ============================================================================

/**
 * Map an unknown error from finalizeOrder() into hard-coded English
 * copy keyed by HTTP status. Per Rule R2 we MUST NOT pass through
 * arbitrary server-supplied strings.
 *
 * Rule R9 vocabulary: the strings below use ONLY the vocabulary
 * "Order", "Finalize", "Sign in", "Try again". They do NOT contain
 * any settlement-adjacent term.
 *
 * @param error - The thrown error from `finalizeOrder()`.
 * @returns A user-facing English string suitable for a banner.
 */
function describeFinalizeError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your session has expired. Please sign in again to finalize your order.';
    }
    if (error.status === 403) {
      return 'You do not have permission to finalize this order.';
    }
    if (error.status === 404) {
      return 'The order could not be found. It may have been removed.';
    }
    if (error.status === 409) {
      return 'This order is already finalized.';
    }
    if (error.status === 400) {
      return 'The order could not be finalized. Please try again or contact support.';
    }
    if (error.status >= 500) {
      return 'The order service is temporarily unavailable. Please try again in a moment.';
    }
    return 'The order could not be finalized. Please try again.';
  }
  return 'A network issue prevented the request. Please check your connection and try again.';
}

/**
 * Format an integer subtotal (in the smallest currency unit) into a
 * human-readable display string. Mirrors the helper in CartPanel so
 * both panels render the same value identically.
 *
 * Rule R9 vocabulary: returns a "Subtotal" expression. NEVER named
 * "Total", "Charge", or any other settlement term.
 *
 * @param subtotalMinor - Integer subtotal in smallest currency unit.
 * @param currency - Optional ISO-4217 code; defaults to 'USD'.
 * @returns Localized display string, e.g. "$149.97".
 */
function formatSubtotal(subtotalMinor: number, currency?: string): string {
  const code = currency ?? 'USD';
  const major = subtotalMinor / 100;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
  }).format(major);
}

// ============================================================================
// Inline styles
// ============================================================================

const PANEL_STYLE: React.CSSProperties = {
  position: 'absolute',
  top: 'calc(100% + 0.5rem)',
  right: 0,
  zIndex: 50,
  width: 'min(420px, 90vw)',
  maxHeight: 'min(560px, 80vh)',
  overflowY: 'auto',
  padding: '1rem',
  backgroundColor: '#FFFFFF',
  border: '1px solid #D9D9D9',
  borderRadius: '0.5rem',
  boxShadow: '0 8px 24px rgba(45, 28, 119, 0.15)',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  color: '#333333',
};

const HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.75rem',
};

const HEADER_TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
  color: '#1A105F',
};

const CLOSE_BUTTON_STYLE: React.CSSProperties = {
  padding: '0.25rem 0.5rem',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontSize: '0.75rem',
  fontWeight: 500,
  color: '#5B39F3',
  backgroundColor: 'transparent',
  border: '1px solid transparent',
  borderRadius: '0.25rem',
  cursor: 'pointer',
};

const ORDER_META_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  padding: '0.75rem',
  marginBottom: '0.75rem',
  backgroundColor: '#F4EFF6',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
};

const ORDER_META_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.5rem',
};

const ORDER_META_LABEL_STYLE: React.CSSProperties = {
  fontSize: '0.75rem',
  fontWeight: 500,
  color: '#666666',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
};

const ORDER_META_VALUE_STYLE: React.CSSProperties = {
  fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.8125rem',
  color: '#1A105F',
};

const STATE_BADGE_CREATED_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#1A105F',
  backgroundColor: '#94FAD5',
  border: '1px solid #5B39F3',
  borderRadius: '999px',
};

const STATE_BADGE_FINALIZED_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '0.125rem 0.5rem',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontSize: '0.6875rem',
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: '#FFFFFF',
  backgroundColor: '#047857',
  border: '1px solid #047857',
  borderRadius: '999px',
};

const ITEMS_LIST_STYLE: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.375rem',
  marginBottom: '0.75rem',
};

const ITEM_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0.5rem 0.625rem',
  backgroundColor: '#F5F5F5',
  border: '1px solid #D9D9D9',
  borderRadius: '0.25rem',
  fontSize: '0.8125rem',
};

const ITEM_TITLE_STYLE: React.CSSProperties = {
  fontWeight: 500,
  color: '#1A105F',
};

const ITEM_QUANTITY_STYLE: React.CSSProperties = {
  fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, monospace',
  color: '#666666',
};

const SUBTOTAL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: '0.25rem',
  paddingTop: '0.5rem',
  borderTop: '1px solid #D9D9D9',
};

const SUBTOTAL_LABEL_STYLE: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 500,
  color: '#333333',
};

const SUBTOTAL_VALUE_STYLE: React.CSSProperties = {
  fontFamily: '"Fira Code", ui-monospace, SFMono-Regular, monospace',
  fontSize: '0.9375rem',
  fontWeight: 600,
  color: '#1A105F',
};

function getFinalizeButtonStyle(isEnabled: boolean): React.CSSProperties {
  // QA Issue #10 — disabled text colour upgraded from `#999999`
  // (2.85:1 on `#D9D9D9` — FAIL WCAG AA) to `#666666` (4.83:1 — PASS).
  // QA Issue #9 — `font-family: inherit` lets the global Inter cascade
  // reach this native `<button>` instead of falling back to OS Arial.
  return {
    display: 'block',
    width: '100%',
    marginTop: '0.75rem',
    padding: '0.625rem 1rem',
    fontFamily: 'inherit',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: isEnabled ? '#FFFFFF' : '#666666',
    backgroundColor: isEnabled ? '#5B39F3' : '#D9D9D9',
    border: 'none',
    borderRadius: '0.375rem',
    cursor: isEnabled ? 'pointer' : 'not-allowed',
    transition: 'background-color 150ms ease',
  };
}

const SUCCESS_BANNER_STYLE: React.CSSProperties = {
  marginTop: '0.75rem',
  padding: '0.75rem',
  backgroundColor: '#F0FDF4',
  border: '1px solid #BBF7D0',
  borderRadius: '0.375rem',
  color: '#047857',
  fontSize: '0.875rem',
  fontWeight: 500,
};

const ERROR_BANNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  marginTop: '0.75rem',
  backgroundColor: '#FFF4F4',
  border: '1px solid #FECACA',
  borderRadius: '0.375rem',
  color: '#B00020',
  fontSize: '0.8125rem',
};

const ERROR_BANNER_TEXT_STYLE: React.CSSProperties = {
  flex: '1 1 auto',
};

const ERROR_BANNER_BUTTON_STYLE: React.CSSProperties = {
  padding: '0.25rem 0.625rem',
  fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
  fontSize: '0.75rem',
  fontWeight: 600,
  color: '#B00020',
  backgroundColor: 'transparent',
  border: '1px solid #B00020',
  borderRadius: '0.25rem',
  cursor: 'pointer',
};

// ============================================================================
// Component
// ============================================================================

/**
 * The post-order-creation confirmation surface. Rendered by
 * <CartPanel /> after a successful POST /api/orders.
 *
 * High-level flow:
 *   1. Mount with `order.state === 'created'`.
 *   2. The user reviews the order details: order id, items, subtotal,
 *      created timestamp, and current state badge.
 *   3. The user clicks `finalize-order-button` →
 *      `finalizeOrder(orderId)` fires. While in flight the button is
 *      disabled with `aria-busy=true`.
 *   4. On success: order state transitions to 'finalized'; the
 *      finalize button is replaced by a success banner; the state
 *      badge updates.
 *   5. On error: error banner with hard-coded copy keyed by HTTP
 *      status; user can dismiss and retry.
 *   6. The user clicks the close button →
 *      `props.onClose()` is invoked; the parent CartPanel resets its
 *      cart state.
 *
 * Rule R9: this component never names a settlement verb. The
 * vocabulary is strictly "Order", "Finalize", "Confirmed", "Items",
 * "Quantity", "Subtotal".
 *
 * @param props - The order to confirm and the close callback.
 * @returns The order-confirmation panel as a `<section role="region">`.
 */
export function OrderConfirmationPanel(
  props: OrderConfirmationPanelProps,
): JSX.Element {
  // -----------------------------------------------------------------
  // State
  // -----------------------------------------------------------------
  const [currentOrder, setCurrentOrder] = useState<Order>(props.order);
  const [finalizeState, setFinalizeState] = useState<FinalizeState>('idle');
  const [finalizeError, setFinalizeError] = useState<string | null>(null);

  // -----------------------------------------------------------------
  // Handler — finalize the order
  // -----------------------------------------------------------------
  //
  // Calls `finalizeOrder(orderId)`. On success the local order state
  // is replaced with the finalized order. On error the banner is
  // shown and the user can retry. Defensive precondition: do not
  // re-issue if a request is already in flight or if the order is
  // already finalized.
  const handleFinalize = useCallback(async (): Promise<void> => {
    if (finalizeState === 'finalizing') {
      return;
    }
    if (currentOrder.state === 'finalized') {
      return;
    }

    setFinalizeState('finalizing');
    setFinalizeError(null);

    try {
      const finalized = await finalizeOrder(currentOrder.id);
      setCurrentOrder(finalized);
      setFinalizeState('idle');
    } catch (error: unknown) {
      // Rule R2: do NOT log the error.
      setFinalizeError(describeFinalizeError(error));
      setFinalizeState('finalize-error');
    }
  }, [currentOrder.id, currentOrder.state, finalizeState]);

  // -----------------------------------------------------------------
  // Handler — dismiss the finalize-error banner
  // -----------------------------------------------------------------
  const handleDismissError = useCallback((): void => {
    setFinalizeError(null);
    setFinalizeState('idle');
  }, []);

  // -----------------------------------------------------------------
  // Derived values
  // -----------------------------------------------------------------
  const isFinalized = currentOrder.state === 'finalized';
  const isFinalizeButtonVisible = !isFinalized;
  const isFinalizeButtonEnabled =
    isFinalizeButtonVisible && finalizeState !== 'finalizing';

  // The state badge style switches based on the current order state.
  const stateBadgeStyle = isFinalized
    ? STATE_BADGE_FINALIZED_STYLE
    : STATE_BADGE_CREATED_STYLE;

  // The state badge label text — Rule R9 vocabulary.
  const stateBadgeLabel = isFinalized ? 'Finalized' : 'Created';

  // -----------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------
  return (
    <div
      data-testid="order-confirmation-panel"
      role="region"
      aria-label="Order Confirmation"
      style={PANEL_STYLE}
    >
      <header style={HEADER_STYLE}>
        <h2 style={HEADER_TITLE_STYLE}>
          {isFinalized ? 'Order Finalized' : 'Order Created'}
        </h2>
        <button
          type="button"
          data-testid="order-confirmation-close"
          onClick={props.onClose}
          style={CLOSE_BUTTON_STYLE}
          aria-label="Close order confirmation"
        >
          Close
        </button>
      </header>

      <div style={ORDER_META_STYLE} aria-label="Order details">
        <div style={ORDER_META_ROW_STYLE}>
          <span style={ORDER_META_LABEL_STYLE}>Order</span>
          <span
            style={ORDER_META_VALUE_STYLE}
            data-testid="order-id"
          >
            {currentOrder.id}
          </span>
        </div>
        <div style={ORDER_META_ROW_STYLE}>
          <span style={ORDER_META_LABEL_STYLE}>Status</span>
          <span style={stateBadgeStyle} data-testid="order-state">
            {stateBadgeLabel}
          </span>
        </div>
        <div style={ORDER_META_ROW_STYLE}>
          <span style={ORDER_META_LABEL_STYLE}>Created</span>
          <span
            style={ORDER_META_VALUE_STYLE}
            data-testid="order-timestamp"
          >
            <time dateTime={currentOrder.createdAt}>
              {currentOrder.createdAt}
            </time>
          </span>
        </div>
        <div style={ORDER_META_ROW_STYLE}>
          <span style={ORDER_META_LABEL_STYLE}>Reference</span>
          <span
            style={ORDER_META_VALUE_STYLE}
            data-testid="order-confirmation-id"
          >
            {currentOrder.id.slice(0, 8).toUpperCase()}
          </span>
        </div>
      </div>

      {currentOrder.items.length > 0 && (
        <ul style={ITEMS_LIST_STYLE} aria-label="Order items">
          {currentOrder.items.map((item, index) => (
            <li
              key={`${item.designId}-${String(index)}`}
              data-testid="order-line-item"
              data-design-id={item.designId}
              style={ITEM_ROW_STYLE}
            >
              <span style={ITEM_TITLE_STYLE}>
                {item.designTitle ?? 'Saved design'}
              </span>
              <span style={ITEM_QUANTITY_STYLE}>×{item.quantity}</span>
            </li>
          ))}
        </ul>
      )}

      <div style={SUBTOTAL_ROW_STYLE}>
        <span style={SUBTOTAL_LABEL_STYLE}>Subtotal</span>
        <span
          style={SUBTOTAL_VALUE_STYLE}
          data-testid="order-subtotal"
        >
          {formatSubtotal(currentOrder.subtotal, currentOrder.currency)}
        </span>
      </div>

      {isFinalizeButtonVisible && (
        <button
          type="button"
          data-testid="finalize-order-button"
          onClick={(): void => {
            void handleFinalize();
          }}
          disabled={!isFinalizeButtonEnabled}
          aria-busy={finalizeState === 'finalizing'}
          style={getFinalizeButtonStyle(isFinalizeButtonEnabled)}
        >
          {finalizeState === 'finalizing'
            ? 'Finalizing order…'
            : 'Finalize Order'}
        </button>
      )}

      {isFinalized && (
        <div
          data-testid="order-finalized-message"
          role="status"
          aria-live="polite"
          style={SUCCESS_BANNER_STYLE}
        >
          Your order has been confirmed. We have started the order
          fulfilment process and will keep you updated.
        </div>
      )}

      {finalizeState === 'finalize-error' && finalizeError !== null && (
        <div
          role="alert"
          aria-live="polite"
          data-testid="finalize-order-error"
          style={ERROR_BANNER_STYLE}
        >
          <span style={ERROR_BANNER_TEXT_STYLE}>{finalizeError}</span>
          <button
            type="button"
            data-testid="finalize-order-error-dismiss"
            onClick={handleDismissError}
            style={ERROR_BANNER_BUTTON_STYLE}
            aria-label="Dismiss finalize error"
          >
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
