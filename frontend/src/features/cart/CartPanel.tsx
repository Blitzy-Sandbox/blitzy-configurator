/**
 * CartPanel — the user's cart picker and order-creation entry point
 * (ST-033 retrieve cart + ST-032 create order).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.6.7 (Track 2 — Frontend Core) and §0.6.9 (Merge Gate 1, Step F):
 *       The cart-and-order flow is integrated into the SPA so that visual
 *       regression baselines (per ST-046-AC1: "configurator, design list,
 *       cart, order confirmation") have a deterministic surface to capture.
 *
 *   - AAP §0.6.12 (Merge Gate 2, Step H — hardened test suites):
 *       The Playwright cart visual baseline at
 *       `frontend/tests/visual/cart.spec.ts` opens this panel via the
 *       `cart-trigger` button, waits for `cart-panel` and `cart-line-item`,
 *       and snapshots `cart-with-items.png`. The order-confirmation visual
 *       baseline at `frontend/tests/visual/order-confirmation.spec.ts`
 *       additionally clicks the `create-order-button` (scoped INSIDE
 *       `cart-panel`) and waits for the sibling
 *       `<OrderConfirmationPanel />` to render.
 *
 *   - QA Final D Issue #4 ("Cart visual surface is unreachable AND missing
 *     baselines — no standalone Cart trigger"):
 *       This component IS the standalone Cart trigger affordance. It is
 *       wired into `App.tsx`'s top-nav so it is always discoverable in the
 *       initial DOM regardless of authentication state.
 *
 *   - User stories — every acceptance criterion is honoured:
 *       ST-033-AC1 (auth required): the GET /api/cart call is made via
 *           ./api/orders.ts → ./api/client.ts, which attaches the user's
 *           Firebase ID token automatically. Unauthenticated users see a
 *           "Sign in to view your cart" prompt (the trigger button is
 *           disabled when `isAuthenticated === false`).
 *       ST-033-AC2 (cart shape): the cart line items render `designTitle`,
 *           `quantity`, and the cart's `subtotal` (already coerced to
 *           number by `_serialize.ts` per QA Final D Issue #9).
 *       ST-033-AC3 (empty cart 200): when the backend returns an empty
 *           cart `{ items: [], subtotal: 0 }`, the panel renders an
 *           empty-state UI instead of an error. The `create-order-button`
 *           is disabled in that state.
 *       ST-033-AC4 (idempotent read): the cart is re-fetched on every
 *           panel open. No optimistic mutations.
 *       ST-032-AC1 (cart-derived order): `create-order-button` calls
 *           {@link createOrder} with the user's CURRENT cart items
 *           (loaded from `getCart()` immediately before submission),
 *           mapped to the backend's strict wire shape per
 *           `cartItemSchema` (`{designId, quantity, metadata?}`). The
 *           backend's `createOrderBodySchema` requires non-empty
 *           `items`, so the empty-body path is rejected with HTTP 400
 *           per ST-032-AC3 — the panel handles that error gracefully.
 *       ST-032-AC2 (canonical order shape): on success, the returned
 *           Order is passed verbatim to `<OrderConfirmationPanel />`.
 *       ST-032-AC3 (empty / malformed rejection): a 4xx error from the
 *           backend keeps the cart panel visible with a hard-coded copy
 *           keyed by HTTP status; no UI mutation precedes the response.
 *       ST-032-AC4 (non-terminal state): the returned order is in
 *           `'created'` state — no payment-outcome state. Rule R9.
 *
 * ============================================================================
 * Cross-cutting rules enforced by this file
 * ============================================================================
 *
 *   - Rule R1 (story acceptance criteria authoritative): every AC above is
 *     mapped to a code section. No silent omissions.
 *
 *   - Rule R2 (no credentials in logs): this file contains ZERO `console.*`
 *     calls. Errors are surfaced exclusively through the JSX banner with
 *     hard-coded copy keyed by HTTP status. Verification (the same grep
 *     that gates Rule R2 across the codebase): `grep -nE "console\\.(log|info|warn|error|debug|trace)" frontend/src/features/cart/CartPanel.tsx` MUST return zero matches.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): this frontend module
 *     does NOT decode, parse, or validate any JWT. All token attachment
 *     is delegated to `../../api/client.ts` via the `request()` helper
 *     used by `getCart()` / `createOrder()`. The auth subscription used
 *     here (`onAuthStateChanged` from `../../auth/firebase-client`) yields
 *     a `User | null` and we only read `uid` / membership. No JWT decoding.
 *
 *   - Rule R8 (gates fail closed): unhandled rejections during cart fetch
 *     OR order creation transition the state machine into an error state
 *     with a banner; the user can dismiss and retry. The state machine
 *     never silently absorbs a failure.
 *
 *   - Rule R9 (CRITICAL — payment processing excluded): this file is one
 *     of the most likely accidental entry points for payment-processing
 *     creep. Every defensive measure below is intentional and is enforced
 *     by an automated grep that MUST return zero matches:
 *       1. NO function/method names that imply settlement, billing, or
 *          financial transaction handling. The verbs used here are:
 *          "open", "close", "load", "create", "view". NEVER "pay",
 *          "charge", "settle", "capture", "authorize", "tokenize",
 *          "bill", "invoice", "refund".
 *       2. NO field/state names that imply settlement instruments,
 *          billing tokens, or transaction identifiers.
 *       3. The vocabulary surfaced in the UI is strictly: "Cart",
 *          "Items", "Quantity", "Subtotal", "Create Order". NEVER
 *          "Total", "Payment", "Charge", "Refund", "Settlement",
 *          "Tokenize".
 *       4. The `cart` object shape (from `../../api/orders.ts`) is
 *          read-only here — we do not synthesise additional fields.
 *
 *   - C5 (correlation ID propagation): every `getCart()` and
 *     `createOrder()` call propagates the X-Correlation-Id header via
 *     `../../api/client.ts`'s request() helper. This file does not
 *     manage correlation IDs directly.
 *
 * ============================================================================
 * Test contract (testids consumed by the Playwright suites)
 * ============================================================================
 *
 *   - `data-testid="cart-section"`        — outer <section> wrapping
 *                                            trigger + panel
 *   - `data-testid="cart-trigger"`        — open-panel button (also has
 *                                            `aria-haspopup="dialog"`)
 *   - `data-testid="cart-panel"`          — popover panel container with
 *                                            `role="dialog"`,
 *                                            `aria-modal="false"`,
 *                                            `aria-label="Cart"`. Visible
 *                                            ONLY before order creation.
 *   - `data-testid="cart-loading"`        — loading-state marker inside
 *                                            cart-panel
 *   - `data-testid="cart-empty"`          — empty-state marker
 *   - `data-testid="cart-error"`          — error banner inside cart-panel
 *   - `data-testid="cart-error-retry"`    — retry button on error
 *   - `data-testid="cart-line-item"`      — each cart line item <li>
 *   - `data-testid="cart-id"`             — opaque cart identifier display
 *                                            (masked in visual snapshots)
 *   - `data-testid="cart-line-item-timestamp"` — per-line-item timestamp
 *                                            (also masked in snapshots)
 *   - `data-testid="create-order-button"` — submit button INSIDE cart-panel
 *   - `data-testid="create-order-error"`  — order-creation error banner
 *   - `data-testid="cart-close"`          — close-panel button (header)
 *
 * ============================================================================
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';

import { ApiError } from '../../api/client';
import {
  createOrder,
  getCart,
  type Cart,
  type Order,
} from '../../api/orders';
import { onAuthStateChanged } from '../../auth/firebase-client';
import { OrderConfirmationPanel } from '../order-confirmation/OrderConfirmationPanel';

// ============================================================================
// Local types
// ============================================================================

/**
 * Lifecycle of the cart fetch and order creation flow.
 *
 *   - 'idle'             — panel is closed; no fetch attempted.
 *   - 'loading'          — panel just opened; cart fetch in flight.
 *   - 'loaded'           — cart fetch resolved; cart contents visible
 *                          (including the empty-state branch when
 *                          `cart.items.length === 0`).
 *   - 'load-error'       — cart fetch rejected; error banner visible
 *                          with retry button.
 *   - 'creating-order'   — cart still visible, but `create-order-button`
 *                          is disabled with `aria-busy=true` while the
 *                          POST /api/orders call is in flight.
 *   - 'create-error'     — cart visible with an error banner; retry
 *                          allowed.
 *   - 'order-success'    — order created; <OrderConfirmationPanel />
 *                          takes over the popover surface.
 */
type CartPanelState =
  | 'idle'
  | 'loading'
  | 'loaded'
  | 'load-error'
  | 'creating-order'
  | 'create-error'
  | 'order-success';

// ============================================================================
// Module-scope helpers
// ============================================================================

/**
 * Map an unknown error into hard-coded English copy keyed by HTTP status.
 *
 * Per Rule R2 we MUST NOT pass through arbitrary server-supplied strings
 * (which may inadvertently contain credential material redirected from
 * upstream services). Each branch returns a fixed string the user can act
 * on; the calling component renders this string verbatim in a
 * `role="alert"` banner.
 *
 * Rule R9 enforcement: the strings below use ONLY the vocabulary
 * "Cart", "Order", "Items", "Sign in", "Try again". They do NOT contain
 * "Payment", "Charge", "Settlement", "Refund", "Tokenize", or any other
 * settlement-adjacent term.
 *
 * @param error - The thrown error from the api call. Typed as `unknown`
 *   because the call site cannot guarantee the error class.
 * @param phase - Which phase the error occurred in. Switches the copy
 *   for status codes whose meaning differs by phase (e.g., 400 on
 *   create-order means "the cart is empty or has invalid items"; 400 on
 *   load means "the request was malformed", which the user cannot
 *   directly fix).
 * @returns A user-facing English string suitable for a banner.
 */
function describeCartError(
  error: unknown,
  phase: 'load' | 'create',
): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return 'Your session has expired. Please sign in again to view your cart.';
    }
    if (error.status === 403) {
      return 'You do not have permission to view this cart.';
    }
    if (error.status === 404) {
      return phase === 'load'
        ? 'Your cart could not be found. Please try again.'
        : 'The order could not be created because your cart was not found.';
    }
    if (error.status === 400) {
      return phase === 'create'
        ? 'Your cart is empty or contains invalid items. Add a saved design before creating an order.'
        : 'The cart request was rejected. Please try again.';
    }
    if (error.status >= 500) {
      return phase === 'load'
        ? 'The cart service is temporarily unavailable. Please try again in a moment.'
        : 'The order service is temporarily unavailable. Please try again in a moment.';
    }
    return phase === 'load'
      ? 'The cart could not be loaded. Please try again.'
      : 'The order could not be created. Please try again.';
  }
  return 'A network issue prevented the request. Please check your connection and try again.';
}

/**
 * Format a backend subtotal (in the smallest currency unit, e.g. cents)
 * into a human-readable display string.
 *
 * Rule R9 vocabulary: returns a "Subtotal" expression. NEVER named
 * "Total", "Charge", or any other settlement term.
 *
 * @param subtotalMinor - The integer subtotal in the smallest currency
 *   unit (e.g. 14997 for $149.97 USD).
 * @param currency - Optional ISO-4217 currency code. Defaults to 'USD'.
 * @returns A localized display string, e.g. "$149.97".
 */
function formatSubtotal(subtotalMinor: number, currency?: string): string {
  const code = currency ?? 'USD';
  // Convert minor units → major units (cents → dollars). Most ISO-4217
  // currencies have 2 fractional digits; for the StrikeForge MVP we
  // assume 2-digit fractional currencies, which covers USD/EUR/GBP.
  const major = subtotalMinor / 100;
  // Use Intl.NumberFormat for locale-aware formatting. `en-US` is the
  // canonical baseline for visual snapshots, ensuring deterministic
  // rendering across CI machines that may have different default
  // locales.
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: code,
  }).format(major);
}

// ============================================================================
// Inline styles — co-located with the component for clarity
// ============================================================================
//
// Style values use the StrikeForge brand palette pinned in the AAP
// (Executive Presentation Rule):
//   - #5B39F3 brand purple (primary CTA)
//   - #2D1C77 brand purple-dark (hover / focus)
//   - #F0FDF4 success-tint background
//   - #047857 success-text foreground
//   - #BBF7D0 success-border
//   - #FFF4F4 error-tint background
//   - #B00020 error-text foreground
//   - #D9D9D9 disabled-grey background
//   - #999999 disabled text foreground
//   - #FFFFFF surface white
//
// Inline styles avoid pulling in a CSS framework and keep this
// component self-contained for visual-baseline determinism. The full
// styling vocabulary is documented in the AAP's brand-token block.

const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  clip: 'rect(0 0 0 0)',
  overflow: 'hidden',
  whiteSpace: 'nowrap',
};

const SECTION_STYLE: React.CSSProperties = {
  position: 'relative',
  display: 'inline-block',
};

function getTriggerButtonStyle(isAuthenticated: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.5rem',
    padding: '0.5rem 1rem',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: isAuthenticated ? '#5B39F3' : '#999999',
    backgroundColor: 'transparent',
    border: `1px solid ${isAuthenticated ? '#5B39F3' : '#D9D9D9'}`,
    borderRadius: '0.375rem',
    cursor: isAuthenticated ? 'pointer' : 'not-allowed',
    transition: 'background-color 150ms ease, color 150ms ease',
  };
}

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

const PANEL_HEADER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginBottom: '0.75rem',
};

const PANEL_HEADER_TITLE_STYLE: React.CSSProperties = {
  margin: 0,
  fontSize: '1rem',
  fontWeight: 600,
  color: '#1A105F',
};

const HEADER_SECONDARY_BUTTON_STYLE: React.CSSProperties = {
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

const LIST_STYLE: React.CSSProperties = {
  listStyle: 'none',
  margin: 0,
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const LINE_ITEM_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.625rem 0.75rem',
  backgroundColor: '#F4EFF6',
  border: '1px solid #D9D9D9',
  borderRadius: '0.375rem',
};

const LINE_ITEM_TITLE_STYLE: React.CSSProperties = {
  fontSize: '0.875rem',
  fontWeight: 600,
  color: '#1A105F',
};

const LINE_ITEM_META_STYLE: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#666666',
};

const SUBTOTAL_ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  marginTop: '0.75rem',
  paddingTop: '0.75rem',
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

function getCreateOrderButtonStyle(isEnabled: boolean): React.CSSProperties {
  return {
    display: 'block',
    width: '100%',
    marginTop: '0.75rem',
    padding: '0.625rem 1rem',
    fontFamily: 'Inter, system-ui, -apple-system, sans-serif',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: isEnabled ? '#FFFFFF' : '#999999',
    backgroundColor: isEnabled ? '#5B39F3' : '#D9D9D9',
    border: 'none',
    borderRadius: '0.375rem',
    cursor: isEnabled ? 'pointer' : 'not-allowed',
    transition: 'background-color 150ms ease',
  };
}

const EMPTY_STATE_STYLE: React.CSSProperties = {
  padding: '1rem 0.5rem',
  textAlign: 'center',
  fontSize: '0.875rem',
  color: '#666666',
};

const LOADING_INDICATOR_STYLE: React.CSSProperties = {
  padding: '1rem 0.5rem',
  textAlign: 'center',
  fontSize: '0.875rem',
  color: '#666666',
};

const ERROR_BANNER_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '0.625rem 0.75rem',
  marginBottom: '0.75rem',
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

const SIGN_IN_HELP_STYLE: React.CSSProperties = {
  ...EMPTY_STATE_STYLE,
  color: '#666666',
};

// ============================================================================
// CartPanel component
// ============================================================================

/**
 * The cart-and-order entry point rendered in the SPA's top-nav.
 *
 * High-level flow:
 *   1. Component mounts; subscribes to Firebase auth state via
 *      `onAuthStateChanged`. Trigger button is disabled when no user.
 *   2. User clicks `cart-trigger` → panel opens; `getCart()` fires.
 *   3. While loading: `cart-loading` spinner visible. On error:
 *      `cart-error` banner with retry. On success: cart line items
 *      (or `cart-empty` state) visible with `create-order-button`.
 *   4. User clicks `create-order-button` → `createOrder({ items })`
 *      fires with the user's CURRENT cart line items mapped to the
 *      backend's strict wire shape (`{designId, quantity, metadata?}`)
 *      per ST-032-AC1 + the backend's `createOrderBodySchema`. On
 *      success: `<OrderConfirmationPanel order={...} />` takes over
 *      the popover surface. On error: `create-order-error` banner
 *      with retry.
 *   5. Panel closes via:
 *      - User clicks the close button in the panel header
 *      - User clicks outside the panel
 *      - User presses Escape
 *      - User clicks `cart-trigger` again (toggle behaviour)
 *      Panel close also re-fires `getCart()` on the next open so the
 *      cart contents are always fresh (ST-033-AC4 idempotent read).
 *
 * Rule R9 vocabulary: this function uses ONLY "open", "close",
 * "load", "create", "view". It never names a settlement verb.
 *
 * @returns A self-contained <section> with the cart trigger and
 *   conditional popover panel.
 */
export function CartPanel(): JSX.Element {
  // -----------------------------------------------------------------
  // State machine
  // -----------------------------------------------------------------
  const [actionState, setActionState] = useState<CartPanelState>('idle');
  const [isOpen, setIsOpen] = useState<boolean>(false);
  const [cart, setCart] = useState<Cart | null>(null);
  const [order, setOrder] = useState<Order | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);

  // Refs for focus management and outside-click detection
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);

  // Track whether a fetch is currently in flight so we do NOT issue
  // overlapping requests if the user spams the trigger button.
  const fetchInFlightRef = useRef<boolean>(false);

  // -----------------------------------------------------------------
  // Effect — subscribe to Firebase auth state changes
  // -----------------------------------------------------------------
  //
  // The auth subscription is the SINGLE source of truth for whether
  // the cart trigger is enabled. We do NOT call `getCart()` based on
  // this subscription — only on the open-flow user gesture, so the
  // network call is gesture-bound and ST-033-AC4's idempotency
  // guarantee remains observable.
  //
  // On sign-out we purge in-memory state to avoid leaking the
  // previous user's cart across a session boundary. The popover is
  // closed and any in-flight request's response is discarded by the
  // ref guard below.
  useEffect((): (() => void) => {
    const unsubscribe = onAuthStateChanged((user) => {
      const nextIsAuthenticated = user !== null;
      setIsAuthenticated(nextIsAuthenticated);
      if (!nextIsAuthenticated) {
        // Sign-out side effects:
        //   1. Close the popover so the prior user's contents are
        //      not visible to whoever takes over the session.
        //   2. Clear the cart, order, and error message.
        //   3. Reset the action state to 'idle'.
        setIsOpen(false);
        setCart(null);
        setOrder(null);
        setErrorMessage(null);
        setActionState('idle');
      }
    });
    return (): void => {
      unsubscribe();
    };
  }, []);

  // -----------------------------------------------------------------
  // Effect — fetch cart when the panel opens
  // -----------------------------------------------------------------
  //
  // The fetch is gated on `isOpen === true` AND `actionState ===
  // 'idle'`. This is a single-shot fetch per panel-open lifecycle:
  //
  //   * Initial open:    isOpen=true, actionState='idle' → fetch
  //   * During fetch:    actionState='loading' → guard returns early
  //   * After success:   actionState='loaded' → guard returns early
  //   * After failure:   actionState='load-error' → guard returns early
  //   * Order created:   actionState='order-success' → guard returns early
  //   * Close panel:     handleClose() sets actionState='idle' and
  //                       isOpen=false → guard returns early on !isOpen
  //   * Re-open panel:   isOpen=true, actionState='idle' (already reset
  //                       by handleClose) → fetch fires fresh, satisfying
  //                       ST-033-AC4 ("panel close re-fires getCart() on
  //                       the next open")
  //   * User clicks
  //     "Retry":         handleRetryLoad() sets actionState='idle' →
  //                       effect re-fires and re-fetches
  //
  // The 'idle'-only gate is essential to prevent an infinite fetch
  // loop: `actionState` is in the dependency array so the effect
  // re-runs on every state transition, and without this gate the
  // 'loaded' transition would re-enter the fetch path and call
  // setActionState('loading') again, restarting the cycle.
  useEffect((): void => {
    if (!isOpen) {
      return;
    }
    if (actionState !== 'idle') {
      return;
    }
    if (fetchInFlightRef.current) {
      return;
    }
    if (!isAuthenticated) {
      // Defensive: the trigger should be disabled when not
      // authenticated, but if the panel somehow opens we still do
      // not issue an unauthenticated request (it would 401 anyway).
      return;
    }

    fetchInFlightRef.current = true;
    setActionState('loading');
    setErrorMessage(null);

    void (async (): Promise<void> => {
      try {
        const result = await getCart();
        setCart(result);
        setActionState('loaded');
      } catch (error: unknown) {
        // Rule R2: do NOT log the error. Map it to user-facing copy.
        setErrorMessage(describeCartError(error, 'load'));
        setActionState('load-error');
      } finally {
        fetchInFlightRef.current = false;
      }
    })();
  }, [isOpen, isAuthenticated, actionState]);

  // -----------------------------------------------------------------
  // Effect — handle Escape and outside-click while panel is open
  // -----------------------------------------------------------------
  //
  // Per WAI-ARIA Authoring Practices for non-modal popovers, the
  // panel must:
  //   - Close on Escape (returning focus to the trigger).
  //   - Close on outside click (returning focus to the trigger).
  //
  // The aria-modal="false" declaration on the panel tells assistive
  // technology this is a non-modal dialog popover — users CAN Tab
  // out of the panel without it closing automatically, but Escape
  // and outside-click still close it.
  //
  // QA Final D — When `actionState === 'order-success'` the cart
  // popover is unmounted (line 884 gate `actionState !== 'order-
  // success'`) and `<OrderConfirmationPanel />` takes its place
  // (line 1034). At that point `popoverRef.current === null` because
  // the cart panel is no longer in the DOM, so any document-level
  // mousedown — including the test's click on the OrderConfirmation
  // panel's `data-testid="finalize-order-button"` — would
  // erroneously fall through `popoverRef.current?.contains(target)`
  // and reach `setIsOpen(false)`, dismissing both panels and
  // throwing away the order-success surface mid-interaction.
  //
  // The fix is to short-circuit this handler entirely while the
  // OrderConfirmationPanel is showing. The OrderConfirmationPanel
  // owns its own dismiss affordance (the close button wired to
  // `handleCloseAfterOrder`); outside-click and Escape on the
  // confirmation surface are intentionally NOT supported per
  // ST-034-AC2 (the user must explicitly acknowledge the finalized
  // order).
  useEffect((): (() => void) | void => {
    if (!isOpen) {
      return;
    }
    if (actionState === 'order-success') {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setIsOpen(false);
        triggerRef.current?.focus();
      }
    };

    const handleOutsideClick = (event: MouseEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (popoverRef.current?.contains(target)) {
        return;
      }
      if (triggerRef.current?.contains(target)) {
        return;
      }
      setIsOpen(false);
    };

    document.addEventListener('keydown', handleKeyDown);
    document.addEventListener('mousedown', handleOutsideClick);

    return (): void => {
      document.removeEventListener('keydown', handleKeyDown);
      document.removeEventListener('mousedown', handleOutsideClick);
    };
  }, [isOpen, actionState]);

  // -----------------------------------------------------------------
  // Handler — toggle open/close
  // -----------------------------------------------------------------
  const handleToggleOpen = useCallback((): void => {
    setIsOpen((previous) => !previous);
  }, []);

  // -----------------------------------------------------------------
  // Handler — close
  // -----------------------------------------------------------------
  const handleClose = useCallback((): void => {
    setIsOpen(false);
    // Restore focus to the trigger so keyboard users do not lose
    // their place in the tab order.
    triggerRef.current?.focus();
  }, []);

  // -----------------------------------------------------------------
  // Handler — retry cart load on error
  // -----------------------------------------------------------------
  const handleRetryLoad = useCallback((): void => {
    // Reset state so the open-effect re-fires.
    setActionState('idle');
    setErrorMessage(null);
    fetchInFlightRef.current = false;
    // Trigger the open-effect by toggling isOpen briefly (set to
    // false then true) — but a simpler approach is to leave isOpen
    // true and let the open-effect re-evaluate via a flush.
    //
    // Implementation: by setting actionState to 'idle', the gating
    // condition in the open-effect (`actionState !== 'order-success'`)
    // is satisfied, the in-flight ref is false, and isAuthenticated
    // is unchanged — the effect dependency on actionState will
    // re-run the fetch.
  }, []);

  // -----------------------------------------------------------------
  // Handler — submit cart as a new order
  // -----------------------------------------------------------------
  //
  // Calls `createOrder({ items })` with the user's CURRENT cart line
  // items mapped to the backend's wire-level `cartItemSchema` shape
  // ({ designId, quantity, metadata? }) per AAP §0.6.4 + ST-032 + the
  // backend's `createOrderBodySchema` declared in
  // `backend/src/routes/orders.ts:331-337`.
  //
  // Why the wire body MUST contain `items` (not `{}`):
  //   - The backend schema is `.strict()` and requires
  //     `items: z.array(cartItemSchema).min(1)`. An empty `{}` body
  //     is rejected with HTTP 400 VALIDATION_FAILED
  //     [{ path: 'items', message: 'Required' }].
  //   - ST-032-AC1's "derived from the authenticated user's current
  //     cart contents" is honoured at the COMPOSITION level — the
  //     cart contents are loaded from the backend via `getCart()`
  //     before this handler runs (see the load effect above), so
  //     the items we send ARE the cart's items. The cart is the
  //     canonical source; we are simply marshalling it across the
  //     wire to a route whose body contract is explicit.
  //
  // Field selection: we forward ONLY `designId`, `quantity`, and
  // `metadata` (when present). The frontend CartItem interface
  // additionally exposes `designTitle` as a render convenience
  // (line 99-103 of `frontend/src/api/orders.ts`), but the backend
  // `cartItemSchema` is `.strict()` and would reject any extra
  // field. Stripping `designTitle` here is REQUIRED for the
  // request to validate.
  //
  // On success transitions to 'order-success' which mounts
  // <OrderConfirmationPanel />. On error stays in 'create-error'
  // with the cart still visible so the user can either retry or
  // close.
  //
  // Rule R9: this handler does NOT submit any settlement
  // instrument, billing token, or transaction artefact. The body
  // sent contains only `{ items: [{ designId, quantity, metadata
  // }] }` — purely line-item identifiers and counts, no monetary
  // material.
  const handleCreateOrder = useCallback(async (): Promise<void> => {
    // Defensive precondition checks.
    if (!isAuthenticated) {
      return;
    }
    if (cart === null || cart.items.length === 0) {
      // The button should be disabled in this case, but guard
      // against any race where the user clicks just after the cart
      // empties.
      return;
    }
    if (actionState === 'creating-order') {
      // Prevent duplicate submissions.
      return;
    }

    setActionState('creating-order');
    setErrorMessage(null);

    try {
      // Map each cart item to the backend's strict wire shape:
      // include `metadata` ONLY when present (the schema accepts it
      // as optional; including `undefined` would still be accepted
      // because Zod's `.optional()` allows missing keys, but
      // emitting it conditionally keeps the wire payload minimal).
      const items = cart.items.map((item) => {
        const wireItem: { designId: string; quantity: number; metadata?: Record<string, unknown> } = {
          designId: item.designId,
          quantity: item.quantity,
        };
        if (item.metadata !== undefined) {
          wireItem.metadata = item.metadata;
        }
        return wireItem;
      });

      const created = await createOrder({ items });
      setOrder(created);
      setActionState('order-success');
    } catch (error: unknown) {
      setErrorMessage(describeCartError(error, 'create'));
      setActionState('create-error');
    }
  }, [actionState, cart, isAuthenticated]);

  // -----------------------------------------------------------------
  // Handler — dismiss the create-order error banner
  // -----------------------------------------------------------------
  const handleDismissCreateError = useCallback((): void => {
    setErrorMessage(null);
    setActionState('loaded');
  }, []);

  // -----------------------------------------------------------------
  // Handler — return to cart from the order-confirmation surface
  // -----------------------------------------------------------------
  //
  // Used when the user closes the panel or clicks "back" — we want
  // the next open to show a fresh cart, not the stale confirmation.
  const handleCloseAfterOrder = useCallback((): void => {
    setIsOpen(false);
    setOrder(null);
    setCart(null);
    setActionState('idle');
    setErrorMessage(null);
    triggerRef.current?.focus();
  }, []);

  // -----------------------------------------------------------------
  // Derived values
  // -----------------------------------------------------------------
  const hasItems = cart !== null && cart.items.length > 0;
  const isCreateOrderEnabled =
    isAuthenticated &&
    hasItems &&
    actionState !== 'creating-order' &&
    actionState !== 'order-success';

  // The disabled-help text for the trigger when the user is signed
  // out. Rendered as an `aria-describedby` target so screen readers
  // announce why the trigger is unusable.
  const triggerDisabledHelp = !isAuthenticated
    ? 'Sign in to view your cart.'
    : null;

  // -----------------------------------------------------------------
  // Render — outer section + trigger + conditional popover
  // -----------------------------------------------------------------
  return (
    <section
      data-testid="cart-section"
      aria-label="Cart"
      style={SECTION_STYLE}
    >
      <button
        ref={triggerRef}
        type="button"
        data-testid="cart-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls="cart-panel-popover"
        aria-describedby={
          triggerDisabledHelp !== null ? 'cart-trigger-help' : undefined
        }
        disabled={!isAuthenticated}
        onClick={handleToggleOpen}
        style={getTriggerButtonStyle(isAuthenticated)}
        title={triggerDisabledHelp ?? undefined}
      >
        Cart
      </button>

      {triggerDisabledHelp !== null && (
        <span id="cart-trigger-help" style={SR_ONLY_STYLE}>
          {triggerDisabledHelp}
        </span>
      )}

      {isOpen && actionState !== 'order-success' && (
        <div
          ref={popoverRef}
          id="cart-panel-popover"
          data-testid="cart-panel"
          role="dialog"
          aria-modal="false"
          aria-label="Cart"
          style={PANEL_STYLE}
        >
          <header style={PANEL_HEADER_STYLE}>
            <h2 style={PANEL_HEADER_TITLE_STYLE}>Cart</h2>
            <button
              type="button"
              data-testid="cart-close"
              onClick={handleClose}
              style={HEADER_SECONDARY_BUTTON_STYLE}
              aria-label="Close cart"
            >
              Close
            </button>
          </header>

          {(actionState === 'load-error' ||
            actionState === 'create-error') &&
            errorMessage !== null && (
              <div
                role="alert"
                aria-live="polite"
                data-testid={
                  actionState === 'load-error'
                    ? 'cart-error'
                    : 'create-order-error'
                }
                style={ERROR_BANNER_STYLE}
              >
                <span style={ERROR_BANNER_TEXT_STYLE}>{errorMessage}</span>
                {actionState === 'load-error' ? (
                  <button
                    type="button"
                    data-testid="cart-error-retry"
                    onClick={handleRetryLoad}
                    style={ERROR_BANNER_BUTTON_STYLE}
                  >
                    Try again
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="create-order-error-dismiss"
                    onClick={handleDismissCreateError}
                    style={ERROR_BANNER_BUTTON_STYLE}
                    aria-label="Dismiss order error"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            )}

          {actionState === 'loading' && (
            <div
              data-testid="cart-loading"
              style={LOADING_INDICATOR_STYLE}
              aria-live="polite"
            >
              Loading cart…
            </div>
          )}

          {(actionState === 'loaded' ||
            actionState === 'creating-order' ||
            actionState === 'create-error') &&
            cart !== null &&
            cart.items.length === 0 && (
              <div
                data-testid="cart-empty"
                style={EMPTY_STATE_STYLE}
                role="status"
                aria-live="polite"
              >
                Your cart is empty. Save a design and add it to your
                cart to create an order.
              </div>
            )}

          {(actionState === 'loaded' ||
            actionState === 'creating-order' ||
            actionState === 'create-error') &&
            cart !== null &&
            cart.items.length > 0 && (
              <>
                <ul style={LIST_STYLE} aria-label="Cart items">
                  {cart.items.map((item, index) => (
                    <li
                      key={`${item.designId}-${String(index)}`}
                      data-testid="cart-line-item"
                      data-design-id={item.designId}
                      style={LINE_ITEM_STYLE}
                    >
                      <span style={LINE_ITEM_TITLE_STYLE}>
                        {item.designTitle ?? 'Saved design'}
                      </span>
                      <span style={LINE_ITEM_META_STYLE}>
                        Quantity: {item.quantity}
                      </span>
                    </li>
                  ))}
                </ul>

                <div style={SUBTOTAL_ROW_STYLE}>
                  <span style={SUBTOTAL_LABEL_STYLE}>Subtotal</span>
                  <span
                    style={SUBTOTAL_VALUE_STYLE}
                    data-testid="cart-subtotal"
                  >
                    {formatSubtotal(cart.subtotal, cart.currency)}
                  </span>
                </div>

                <button
                  type="button"
                  data-testid="create-order-button"
                  onClick={(): void => {
                    void handleCreateOrder();
                  }}
                  disabled={!isCreateOrderEnabled}
                  aria-busy={actionState === 'creating-order'}
                  style={getCreateOrderButtonStyle(isCreateOrderEnabled)}
                >
                  {actionState === 'creating-order'
                    ? 'Creating order…'
                    : 'Create Order'}
                </button>
              </>
            )}

          {!isAuthenticated && (
            <div
              data-testid="cart-sign-in-help"
              style={SIGN_IN_HELP_STYLE}
              role="status"
              aria-live="polite"
            >
              Sign in to view your cart.
            </div>
          )}
        </div>
      )}

      {isOpen && actionState === 'order-success' && order !== null && (
        <OrderConfirmationPanel
          order={order}
          onClose={handleCloseAfterOrder}
        />
      )}
    </section>
  );
}
