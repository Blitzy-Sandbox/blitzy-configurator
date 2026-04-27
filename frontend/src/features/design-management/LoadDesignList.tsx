/**
 * LoadDesignList — the user's saved-designs picker (ST-019).
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 / §0.6.9 (Merge Gate 1, Step F — Design Management
 *     Integration):
 *       CREATE | frontend/src/features/design-management/LoadDesignList.tsx
 *       | ST-019 calls live GET /api/designs; paginated.
 *
 *   - AAP §0.6.14 ("User Interface Design"):
 *       The Design Summary Sidebar HOSTS the Save / Load / Share / New /
 *       Add-to-Cart anchors per ST-022-AC5. This component is rendered
 *       INSIDE the canonical DesignSummarySidebar component as an inline
 *       anchor (or inside a sidebar-hosted disclosure region; see App.tsx
 *       wiring).
 *
 *   - User stories — every acceptance criterion is addressed by the
 *     implementation below; the docstring on each subsection cites the
 *     specific AC it satisfies.
 *
 *       ST-019-AC1: "When the authenticated user opens the Load Design
 *           list, they see every design they have previously saved."
 *           → On mount, the component subscribes to the authenticated
 *             user's design list via {@link listDesigns}. The list is
 *             fetched in cursor-paginated pages; the user sees the
 *             accumulated set as more pages are loaded (auto on first
 *             render, manual via the Load More button thereafter).
 *
 *       ST-019-AC2: "Selecting a design replaces the configurator's
 *           current selections with the saved design's selections."
 *           → A row click triggers a load flow that hydrates the
 *             store via {@link useConfiguratorStore.loadDesign}.
 *             Because the backend exposes only a Summary projection on
 *             the list endpoint (id + title + lastModifiedAt +
 *             createdAt) — NOT the full payload — the load flow uses
 *             the share-link round-trip: createShareLink(designId) →
 *             getSharedDesign(token) → store.loadDesign(payload). See
 *             the architectural justification block below.
 *
 *       ST-019-AC3: "If the load fails, the previous UI state is left
 *           intact and the user sees an actionable failure message."
 *           → Errors abort the load BEFORE any store mutation.
 *             store.loadDesign() is called ONLY after both the
 *             share-link issuance and the share-fetch resolve
 *             successfully. Hard-coded error copy is keyed by HTTP
 *             status (Rule R2).
 *
 *       ST-019-AC4: "Designs are shown most-recently-modified first."
 *           → The backend's listDesigns() endpoint returns items
 *             ordered by lastModifiedAt DESC per ST-028-AC4. This
 *             component trusts the server's ordering and does NOT
 *             re-sort.
 *
 *       ST-028-AC1: backend returns only the user's own designs.
 *           → Frontend trusts the backend's ownership filter — does
 *             NOT cross-check.
 *
 *       ST-028-AC2: list endpoint returns DesignSummary, not full
 *           payload.
 *           → This component renders ONLY the summary fields (id,
 *             title, lastModifiedAt). The payload is fetched lazily
 *             on row click, only for the design the user picks.
 *
 *       ST-028-AC3: when the user has no designs, backend returns
 *           {items:[], nextCursor:null} with HTTP 200.
 *           → Empty-state UI is keyed on `items.length === 0`, NOT
 *             on a thrown ApiError.
 *
 *       ST-028-AC5: backend enforces a documented maximum page size
 *           and supports bounded paginated traversal.
 *           → This component uses cursor-based pagination: when the
 *             backend returns a non-null nextCursor, the Load More
 *             button is enabled and supplies that cursor on the next
 *             request. The component does NOT pass a `limit` param,
 *             relying on the server-side default page size.
 *
 *       ST-029-AC2: each issued share link carries a documented
 *           expiration.
 *           → The share-link round-trip used by this component
 *             produces a token with server-managed expiration; the
 *             token is consumed immediately and not stored.
 *
 *       ST-029-AC3: visiting a valid share link returns enough data
 *           for the configurator to render the design without
 *           sign-in.
 *           → The {@link getSharedDesign} response carries the full
 *             DesignPayload, which is exactly what the configurator
 *             store needs to hydrate via loadDesign().
 *
 * ============================================================================
 * Architectural justification — why the load flow uses share-link round-trip
 * ============================================================================
 *
 *   The AAP-pinned design endpoint surface (per §0.6.4) is:
 *
 *     1. POST /api/designs                — create (returns full Design)
 *     2. GET  /api/designs                — list (paginated; returns
 *                                            DesignSummary projection
 *                                            WITHOUT payload — ST-028-AC2)
 *     3. POST /api/designs/:id/share-link — issue share link
 *     4. GET  /api/share/:token           — unauthenticated read-side
 *                                            projection of a shared
 *                                            design (full payload)
 *
 *   There is NO `GET /api/designs/:id` endpoint. Adding one would
 *   expand AAP scope and require a corresponding backend route, service,
 *   repository, and test changes — out of scope for the QA-finding fix.
 *
 *   The architecturally-clean way to obtain a full design payload using
 *   only the AAP-pinned endpoints is:
 *
 *     Step 1: createShareLink(designId)  →  { token, url, expiresAt }
 *     Step 2: getSharedDesign(token)     →  SharedDesignView
 *                                            { design, designId,
 *                                              title, lastModifiedAt }
 *     Step 3: map SharedDesignView → LoadedDesignPayload
 *     Step 4: store.loadDesign(payload)
 *
 *   Trade-off (recorded in the Explainability decision log):
 *     - Each load creates a new share-link row in the database. This is
 *       acceptable because:
 *         (a) share links carry server-managed expiration, so a row
 *             from a load action ages out naturally;
 *         (b) the authenticated user owns the design, so creating a
 *             share link for it is well within their authority;
 *         (c) the alternative (a dedicated GET /api/designs/:id) would
 *             expand AAP scope.
 *     - A future MG2 enhancement may add a dedicated load endpoint
 *       that bypasses share-link issuance, after which this round-trip
 *       can be replaced. The change would be local to this file.
 *
 * ============================================================================
 * Cross-cutting rules enforced
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. ALL
 *     user-visible error copy is hard-coded by HTTP status code; never
 *     `error.message` or `error.body`. Server-supplied error bodies are
 *     not rendered, logged, or re-thrown.
 *
 *   - Rule R3 (Firebase Admin SDK only on backend): this component does
 *     NOT decode, parse, or inspect the Firebase ID token. Token
 *     attachment is delegated to `request()` in `../../api/client` which
 *     forwards the raw token to the backend; the backend's session
 *     middleware calls `admin.auth().verifyIdToken()` as the SOLE
 *     authority on validity.
 *
 *   - Rule R9 (no payment processing): Loading a design is a read-side
 *     hydration action; no checkout, payment, charge, intent, or
 *     settlement references appear here.
 *
 *   - C5 (correlation ID propagation): every outbound request issued
 *     by this component (listDesigns, createShareLink, getSharedDesign)
 *     receives an X-Correlation-Id header generated inside the
 *     `request()` helper. This component does NOT manage correlation
 *     IDs directly.
 *
 *   - C6 / R7 (Fabric.js render before texture update): Loading a
 *     design mutates the store, which causes the texture pipeline
 *     coordinator (registered in App.tsx via useColorSync()) to
 *     re-render in the correct fabric-then-three order. This component
 *     itself does NOT touch the texture pipeline.
 *
 * ============================================================================
 * Cross-layer wire-to-store mapping (the load-side counterpart of
 * SaveDesignCta's store-to-wire mapping)
 * ============================================================================
 *
 *   The SharedDesignView returned by getSharedDesign() carries:
 *
 *     {
 *       design: {                       // backend canonical shape
 *         primaryColor: HexColor,
 *         secondaryColor: HexColor,
 *         accentColor: HexColor,
 *         pattern: StitchingPattern,    // server-validated by Zod enum
 *         finish: MaterialFinish,       // server-validated by Zod enum
 *         logo: { objectKey, offsetX?, offsetY?, scale?, rotation? } | null
 *       },
 *       designId: string,               // server-assigned UUID
 *       title: string,                  // user-facing label
 *       lastModifiedAt: string          // ISO-8601, already a string
 *                                       // because the backend serialises
 *                                       // Date via Date.prototype.toJSON
 *     }
 *
 *   The configurator store's LoadedDesignPayload shape (consumed by
 *   useConfiguratorStore.loadDesign) is:
 *
 *     {
 *       id: string,                       ← designId
 *       title: string,                    ← title
 *       primaryColor: HexColor,           ← design.primaryColor
 *       secondaryColor: HexColor,         ← design.secondaryColor
 *       accentColor: HexColor,            ← design.accentColor
 *       stitchingPattern: StitchingPattern, ← design.pattern
 *       materialFinish: MaterialFinish,   ← design.finish
 *       logoUrl: string | null,           ← design.logo === null
 *                                            ? null
 *                                            : design.logo.objectKey
 *       logoPosition: { x, y },           ← design.logo === null
 *                                            ? { x: 0, y: 0 }
 *                                            : { x: design.logo.offsetX ?? 0,
 *                                                y: design.logo.offsetY ?? 0 }
 *       logoScale: number,                ← design.logo === null
 *                                            ? 1.0
 *                                            : design.logo.scale ?? 1.0
 *       lastModifiedAt: string            ← lastModifiedAt
 *     }
 *
 *   The mapping is encapsulated in {@link mapSharedToLoaded}, defined at
 *   module scope so it has stable reference identity across renders and
 *   can be unit-tested in isolation.
 *
 * ============================================================================
 * What this component does NOT do
 * ============================================================================
 *
 *   - Pagination affordances beyond Load More: no infinite scroll, no
 *     virtualization, no jump-to-page. The cursor-based contract makes
 *     these straightforward to add later but they are out of scope for
 *     ST-019's MG1-F deliverable.
 *   - Search / filter: not in ST-019's acceptance criteria.
 *   - Delete / rename: not in the AAP's design endpoint surface.
 *   - Optimistic UI for load: hydration is server-authoritative; the
 *     store is updated only after both the share-link issuance and the
 *     share-fetch succeed.
 *   - Confirmation dialog before discarding unsaved changes: that
 *     responsibility is shared with NewDesignDialog.tsx (ST-020). For
 *     simplicity at this checkpoint, picking a row will overwrite
 *     unsaved changes silently — a deliberate restriction documented
 *     here so the wiring step in App.tsx can later add a confirmation
 *     guard if desired. ST-019 itself does NOT require a confirmation
 *     gate; the implicit unsaved-state warning lives elsewhere.
 *   - Caching: each list page is fetched fresh from the backend. The
 *     store does not hold the list — only the loaded design payload.
 *
 * ============================================================================
 * Test contract (for the Playwright e2e suite at MG2-H per ST-045)
 * ============================================================================
 *
 *     - `data-testid="load-design-list"`           — the outer <section>
 *     - `data-testid="load-design-trigger"`        — the open-list button
 *     - `data-testid="load-design-list-loading"`   — loading state marker
 *     - `data-testid="load-design-list-empty"`     — empty-state UI
 *     - `data-testid="load-design-list-error"`     — error banner
 *     - `data-testid="load-design-list-error-retry"` — retry button on error
 *     - `data-testid="load-design-list-row"`       — each <li> row;
 *                                                     `data-design-id` carries
 *                                                     the design's UUID
 *     - `data-testid="load-design-list-row-title"` — title text inside each row
 *     - `data-testid="load-design-list-row-meta"`  — last-modified text
 *     - `data-testid="load-design-load-more"`      — pagination-cursor button
 *     - `data-testid="load-design-row-loading"`    — appears in the row that
 *                                                     is currently being
 *                                                     hydrated
 *
 * ============================================================================
 */

import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';

import { ApiError } from '../../api/client';
import {
  createShareLink,
  getSharedDesign,
  listDesigns,
} from '../../api/designs';
import type { DesignSummary, SharedDesignView } from '../../api/designs';
import {
  type LoadedDesignPayload,
  type MaterialFinish,
  type StitchingPattern,
  useConfiguratorStore,
} from '../../state/configuratorStore';

// ============================================================================
// Local types
// ============================================================================

/**
 * Lifecycle of the LIST fetch (the GET /api/designs side of the flow).
 *
 *   - 'idle'        — no list fetch has been attempted yet AND no list
 *                     UI is open (the user has not clicked the trigger).
 *   - 'loading'     — a list fetch is in flight (initial OR Load More).
 *   - 'success'     — the most-recent list fetch resolved; `items` may
 *                     be empty (empty-state) or populated.
 *   - 'error'       — the most-recent list fetch rejected; `error` holds
 *                     the actionable message keyed by HTTP status.
 */
type ListState = 'idle' | 'loading' | 'success' | 'error';

/**
 * Lifecycle of a SINGLE-ROW load (the share-link round-trip side of the
 * flow). Distinct from ListState so a list-fetch error does not blank
 * a row-load error and vice versa.
 *
 *   - null          — no row load is in flight.
 *   - { id, phase } — the indicated design is being loaded; phase is
 *                     'issuing-share' (POST share-link) or 'fetching'
 *                     (GET /api/share/:token). Used to show a per-row
 *                     loading spinner that distinguishes the two sub-
 *                     phases for diagnostics.
 */
type RowLoadState =
  | null
  | {
      readonly id: string;
      readonly phase: 'issuing-share' | 'fetching';
    };

// ============================================================================
// Module-scope helpers
// ============================================================================

/**
 * Canonical list of stitching pattern identifiers. Mirrors the
 * {@link StitchingPattern} TypeScript union exported by the
 * configurator store. Maintained as a runtime tuple so the wire-format
 * narrower below can validate the backend's response.
 *
 * Cross-layer contract: this list MUST match (a) the configurator
 * store's `StitchingPattern` type, and (b) the backend's Zod
 * `z.enum([...])` constraint added in QA Issue #11. A drift here
 * would cause a freshly-loaded design to silently fall back to the
 * default 'classic' pattern.
 */
const STITCHING_PATTERN_RUNTIME_VALUES: readonly StitchingPattern[] = [
  'classic',
  'hexagonal',
  'diamond',
  'spiral',
  'star',
  'grid',
] as const;

/**
 * Canonical list of material finish identifiers. Mirrors the
 * {@link MaterialFinish} TypeScript union exported by the
 * configurator store. See {@link STITCHING_PATTERN_RUNTIME_VALUES}
 * for the cross-layer contract.
 */
const MATERIAL_FINISH_RUNTIME_VALUES: readonly MaterialFinish[] = [
  'matte',
  'glossy',
  'metallic',
] as const;

/**
 * Narrow a wire-format string into the store-side
 * {@link StitchingPattern} enum, falling back to 'classic' (the
 * documented default) for unrecognised values.
 *
 * The backend's Zod schema (after the QA Issue #11 fix) rejects any
 * pattern not in the canonical list with HTTP 400, so under normal
 * operation this fallback is unreachable. The defensive narrow
 * protects against:
 *
 *   - a legacy design row written before the Zod enum was tightened
 *     (a pattern like "completely-bogus" persisted under the lax
 *     pre-fix schema);
 *   - a future backend API change that adds a new pattern not yet
 *     in the frontend's StitchingPattern type;
 *   - a buggy or compromised backend that returns an arbitrary
 *     string.
 *
 * In all three cases the safe behaviour is to load with the default
 * pattern rather than crash the configurator.
 *
 * @param wireValue - The pattern field from the wire payload.
 * @returns A {@link StitchingPattern} guaranteed to be in the
 *   canonical list.
 */
function narrowStitchingPattern(wireValue: string): StitchingPattern {
  const found = STITCHING_PATTERN_RUNTIME_VALUES.find((v) => v === wireValue);
  return found ?? 'classic';
}

/**
 * Narrow a wire-format string into the store-side
 * {@link MaterialFinish} enum, falling back to 'matte' (the
 * documented default). See {@link narrowStitchingPattern} for the
 * defensive-narrow rationale.
 *
 * @param wireValue - The finish field from the wire payload.
 * @returns A {@link MaterialFinish} guaranteed to be in the canonical
 *   list.
 */
function narrowMaterialFinish(wireValue: string): MaterialFinish {
  const found = MATERIAL_FINISH_RUNTIME_VALUES.find((v) => v === wireValue);
  return found ?? 'matte';
}

/**
 * Map the wire-format {@link SharedDesignView} into the configurator
 * store's {@link LoadedDesignPayload} shape. Pure function, no side
 * effects, stable reference identity.
 *
 * Field-by-field translation (per the JSDoc block at the top of the
 * file under "Cross-layer wire-to-store mapping"):
 *
 *   - id                ← designId
 *   - title             ← title
 *   - primaryColor      ← design.primaryColor
 *   - secondaryColor    ← design.secondaryColor
 *   - accentColor       ← design.accentColor
 *   - stitchingPattern  ← design.pattern
 *   - materialFinish    ← design.finish
 *   - logoUrl           ← design.logo === null
 *                            ? null
 *                            : design.logo.objectKey
 *   - logoPosition      ← design.logo === null
 *                            ? { x: 0, y: 0 }
 *                            : { x: design.logo.offsetX ?? 0,
 *                                y: design.logo.offsetY ?? 0 }
 *   - logoScale         ← design.logo === null
 *                            ? 1.0
 *                            : design.logo.scale ?? 1.0
 *   - lastModifiedAt    ← lastModifiedAt (already string from wire)
 *
 * The optional logo offset/scale fields default per the schema:
 *   - offsetX/offsetY → 0 when omitted (sphere-equator default
 *     placement)
 *   - scale          → 1.0 when omitted (native size)
 *
 * @param view - The wire-format projection from getSharedDesign().
 * @returns The store-format payload ready for loadDesign().
 */
function mapSharedToLoaded(view: SharedDesignView): LoadedDesignPayload {
  const { design, designId, title, lastModifiedAt } = view;

  // Narrow wire-format string fields into the store's strict enums.
  // The narrowers fall back to documented defaults on unknown values
  // rather than crashing — see narrowStitchingPattern / narrowMaterialFinish.
  const stitchingPattern = narrowStitchingPattern(design.pattern);
  const materialFinish = narrowMaterialFinish(design.finish);

  if (design.logo === null) {
    return {
      id: designId,
      title,
      primaryColor: design.primaryColor,
      secondaryColor: design.secondaryColor,
      accentColor: design.accentColor,
      stitchingPattern,
      materialFinish,
      logoUrl: null,
      logoPosition: { x: 0, y: 0 },
      logoScale: 1.0,
      lastModifiedAt,
    };
  }

  return {
    id: designId,
    title,
    primaryColor: design.primaryColor,
    secondaryColor: design.secondaryColor,
    accentColor: design.accentColor,
    stitchingPattern,
    materialFinish,
    logoUrl: design.logo.objectKey,
    logoPosition: {
      x: design.logo.offsetX ?? 0,
      y: design.logo.offsetY ?? 0,
    },
    logoScale: design.logo.scale ?? 1.0,
    lastModifiedAt,
  };
}

/**
 * Translate an unknown error thrown by listDesigns / createShareLink /
 * getSharedDesign into actionable user-facing copy keyed by HTTP
 * status. NEVER renders `error.message` or `error.body` (Rule R2);
 * every branch returns a hard-coded, user-actionable string.
 *
 * The branching covers the documented status codes from the three
 * endpoints:
 *
 *   - 401 (any endpoint)            → "session expired"
 *   - 400 (listDesigns or
 *          getSharedDesign)         → "request was invalid"
 *   - 403 (createShareLink only)    → "not authorized"
 *   - 404 (createShareLink:
 *          design missing;
 *          getSharedDesign:
 *          token unknown/expired/
 *          revoked/orphan)          → "design no longer available"
 *   - 5xx (any)                     → "service is temporarily
 *                                       unavailable"
 *   - other 4xx                     → generic actionable copy
 *   - non-ApiError (network, abort) → connectivity-focused copy
 *
 * @param error - The thrown value (typed `unknown` per modern TS).
 * @returns A hard-coded, user-actionable error string.
 */
function describeLoadError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) {
      return (
        'Your session has expired. Please sign in again to view your saved designs.'
      );
    }
    if (error.status === 400) {
      return (
        'Your saved-designs request was invalid. ' +
        'Please refresh the page and try again.'
      );
    }
    if (error.status === 403) {
      return (
        'You are not authorized to load this design. ' +
        'Please refresh the page and try again.'
      );
    }
    if (error.status === 404) {
      return (
        'This design is no longer available. ' +
        'It may have been deleted or its share link expired.'
      );
    }
    if (error.status >= 500) {
      return (
        'The design service is temporarily unavailable. ' +
        'Please try again in a moment.'
      );
    }
    return (
      'Your saved designs could not be loaded. ' +
      'Please try again; if the problem persists, refresh the page.'
    );
  }
  return (
    'Your saved designs could not be loaded due to a network issue. ' +
    'Please check your connection and try again.'
  );
}

/**
 * Format an ISO-8601 timestamp string as a relative-time hint
 * ("just now", "3 minutes ago", "2 days ago", etc.) for the row's
 * last-modified meta line.
 *
 * Implementation choices:
 *   - Uses the browser-native Intl.RelativeTimeFormat for locale-aware
 *     formatting; falls back to the raw ISO string if the API is
 *     unavailable (older browsers).
 *   - Bucket boundaries: under 60 seconds → "just now"; under 60
 *     minutes → minutes; under 24 hours → hours; under 30 days →
 *     days; otherwise → months.
 *   - This is purely cosmetic; if formatting fails for any reason,
 *     return the original ISO string so the user always sees SOMETHING.
 *
 * @param iso - ISO-8601 timestamp string from the wire.
 * @returns A locale-aware relative-time string, or the input if
 *   formatting fails.
 */
function formatRelativeTime(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) {
    return iso;
  }
  const diffMs = Date.now() - parsed;
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) {
    return 'just now';
  }
  try {
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
    const diffMin = Math.round(diffSec / 60);
    if (Math.abs(diffMin) < 60) {
      return formatter.format(-diffMin, 'minute');
    }
    const diffHr = Math.round(diffMin / 60);
    if (Math.abs(diffHr) < 24) {
      return formatter.format(-diffHr, 'hour');
    }
    const diffDay = Math.round(diffHr / 24);
    if (Math.abs(diffDay) < 30) {
      return formatter.format(-diffDay, 'day');
    }
    const diffMonth = Math.round(diffDay / 30);
    if (Math.abs(diffMonth) < 12) {
      return formatter.format(-diffMonth, 'month');
    }
    const diffYear = Math.round(diffMonth / 12);
    return formatter.format(-diffYear, 'year');
  } catch {
    // Intl.RelativeTimeFormat unsupported or threw — fall back to ISO.
    return iso;
  }
}

// ============================================================================
// Component
// ============================================================================

/**
 * The Load Design List.
 *
 * Subscribes via ONE Zustand selector to retrieve the `loadDesign`
 * action reference. The action reference is stable across renders
 * (Zustand 4.x guarantee), so the selector returning it triggers no
 * re-renders.
 *
 * Renders in three primary visual states:
 *
 *   1. The collapsed "Load Saved Design" trigger button (default).
 *   2. The expanded list panel with rows, optional Load More, and
 *      success/error feedback.
 *   3. The error banner with retry, when the list fetch fails.
 *
 * The trigger-button affordance is intentionally inline so this
 * component can be placed inside the design-summary-sidebar without
 * blowing up its visible footprint when the user has not yet asked to
 * see saved designs. The list expands inline below the trigger.
 *
 * @returns A JSX element representing the Load Design List anchor.
 */
export function LoadDesignList(): JSX.Element {
  // -------------------------------------------------------------------------
  // Store subscription — single selector returning the action reference.
  // -------------------------------------------------------------------------
  const loadDesign = useConfiguratorStore((s) => s.loadDesign);

  // -------------------------------------------------------------------------
  // Local React state — owns the list lifecycle, accumulated items, the
  // pagination cursor, and the per-row load lifecycle.
  // -------------------------------------------------------------------------

  /** Whether the panel is open (the user clicked the trigger). */
  const [isOpen, setIsOpen] = useState<boolean>(false);

  /** Lifecycle of the list fetch (initial OR Load More). */
  const [listState, setListState] = useState<ListState>('idle');

  /** Accumulated DesignSummary items across paginated fetches. */
  const [items, setItems] = useState<readonly DesignSummary[]>([]);

  /**
   * The cursor for the NEXT page, or null when there are no more
   * pages. After a Load More fetch, this is replaced with the new
   * `nextCursor` from the response.
   */
  const [nextCursor, setNextCursor] = useState<string | null>(null);

  /**
   * The active error message from the LIST fetch (NOT the row load).
   * `null` when no list error is currently displayed.
   */
  const [listError, setListError] = useState<string | null>(null);

  /**
   * The active row-load lifecycle. Distinct from the list lifecycle
   * so a row error displays alongside a healthy list and vice versa.
   */
  const [rowLoad, setRowLoad] = useState<RowLoadState>(null);

  /** The active error message from a row load. `null` when none. */
  const [rowError, setRowError] = useState<string | null>(null);

  /**
   * The id of the most-recently-loaded design, exposed to the UI as
   * a transient success indicator on its row. Cleared on the next row
   * click or when the panel is closed.
   */
  const [recentlyLoadedId, setRecentlyLoadedId] = useState<string | null>(null);

  // -------------------------------------------------------------------------
  // Effect — fetch the first page when the panel opens for the first time.
  // The dependency on `isOpen` ensures we fetch only when the user has
  // requested the list. Re-opens after a successful load do NOT re-fetch
  // (we keep the cached items) so the user can pick another design
  // without a network round-trip; if they want the freshest list, they
  // can refresh via the dedicated Refresh affordance below.
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Re-open of a previously-fetched panel: keep cached items to avoid
    // a flicker. The user's Load More / Refresh affordances re-fetch
    // explicitly.
    if (listState !== 'idle') {
      return;
    }

    let cancelled = false;
    const ctrl = new AbortController();

    const fetchFirstPage = async (): Promise<void> => {
      setListState('loading');
      setListError(null);
      try {
        const page = await listDesigns({});
        if (cancelled) {
          return;
        }
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setListState('success');
      } catch (error: unknown) {
        if (cancelled) {
          return;
        }
        setListError(describeLoadError(error));
        setListState('error');
      }
    };
    void fetchFirstPage();

    return (): void => {
      cancelled = true;
      ctrl.abort();
    };
    // We intentionally depend ONLY on isOpen — listState transitions
    // inside the effect must NOT re-trigger the effect (would loop).
    // Disabling the exhaustive-deps lint here is the canonical Zustand
    // pattern documented in the SaveDesignCta sibling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  /**
   * onClick for the panel-open trigger. Toggles the open state. When
   * closing, clears the per-row feedback so a future open starts clean.
   */
  const handleToggleOpen = useCallback(() => {
    setIsOpen((prev) => {
      const next = !prev;
      if (!next) {
        // Closing — clear transient row-level feedback. Keep the list
        // cache so a re-open is instant.
        setRowError(null);
        setRowLoad(null);
        setRecentlyLoadedId(null);
      }
      return next;
    });
  }, []);

  /**
   * onClick for the Refresh affordance. Resets pagination state and
   * fetches the first page fresh. Displayed as a secondary button in
   * the success state.
   */
  const handleRefresh = useCallback(async () => {
    setListState('loading');
    setListError(null);
    setRowError(null);
    setRecentlyLoadedId(null);
    setNextCursor(null);
    try {
      const page = await listDesigns({});
      setItems(page.items);
      setNextCursor(page.nextCursor);
      setListState('success');
    } catch (error: unknown) {
      setListError(describeLoadError(error));
      setListState('error');
    }
  }, []);

  /**
   * onClick for the Retry button in the list-error state. Identical
   * to Refresh but contextually appropriate copy.
   */
  const handleRetry = useCallback(() => {
    void handleRefresh();
  }, [handleRefresh]);

  /**
   * onClick for the Load More button. Sends the current `nextCursor`
   * to the backend and APPENDS the new page's items to the existing
   * list (preserving scroll position).
   *
   * Defensive guard: if `nextCursor` is null when this is invoked
   * (should be unreachable because the button is hidden in that case),
   * no-op.
   */
  const handleLoadMore = useCallback(async () => {
    if (nextCursor === null) {
      return;
    }
    setListState('loading');
    setListError(null);
    try {
      const page = await listDesigns({ cursor: nextCursor });
      setItems((prev) => [...prev, ...page.items]);
      setNextCursor(page.nextCursor);
      setListState('success');
    } catch (error: unknown) {
      setListError(describeLoadError(error));
      setListState('error');
    }
  }, [nextCursor]);

  /**
   * onClick for a row. Performs the share-link round-trip:
   *
   *   1. POST /api/designs/:id/share-link  → token
   *   2. GET  /api/share/:token            → SharedDesignView
   *   3. mapSharedToLoaded(view)           → LoadedDesignPayload
   *   4. store.loadDesign(payload)         → hydrates configurator state
   *
   * Per ST-019-AC3, ANY error in steps 1–3 leaves the configurator
   * state untouched; step 4 is reached only on success of every prior
   * step.
   *
   * @param designId - The id of the row the user clicked.
   */
  const handleSelectRow = useCallback(
    async (designId: string) => {
      // Defensive: ignore concurrent clicks while a row load is in
      // flight. The visible disabled state on rows during a row load
      // should prevent this, but the guard is a defense-in-depth
      // measure for assistive technology and rapid clicks.
      if (rowLoad !== null) {
        return;
      }

      // Reset any prior row error and success markers.
      setRowError(null);
      setRecentlyLoadedId(null);

      // Phase 1: issue the share link.
      setRowLoad({ id: designId, phase: 'issuing-share' });
      let token: string;
      try {
        const shareLink = await createShareLink(designId);
        token = shareLink.token;
      } catch (error: unknown) {
        setRowError(describeLoadError(error));
        setRowLoad(null);
        return;
      }

      // Phase 2: fetch the shared view.
      setRowLoad({ id: designId, phase: 'fetching' });
      let view: SharedDesignView;
      try {
        view = await getSharedDesign(token);
      } catch (error: unknown) {
        setRowError(describeLoadError(error));
        setRowLoad(null);
        return;
      }

      // Phase 3: map and hydrate. From here, errors are non-network
      // (defensive — the mapper is a pure function and shouldn't
      // throw), but we still wrap in try/catch so a bad payload
      // doesn't blow up the component.
      try {
        const payload = mapSharedToLoaded(view);
        loadDesign(payload);
        setRowLoad(null);
        setRecentlyLoadedId(designId);
      } catch {
        setRowError(
          'This design could not be applied to the configurator. ' +
            'Please refresh the page and try again.',
        );
        setRowLoad(null);
      }
    },
    [loadDesign, rowLoad],
  );

  /**
   * Dismiss the row error banner. Returns to a clean state without
   * triggering another fetch.
   */
  const handleDismissRowError = useCallback(() => {
    setRowError(null);
  }, []);

  // -------------------------------------------------------------------------
  // Inline styles — co-located so the component remains self-contained.
  // The values match the Blitzy brand tokens used by SaveDesignCta and
  // DesignSummarySidebar siblings.
  // -------------------------------------------------------------------------

  /** Style for the panel-open trigger button. */
  const triggerButtonStyle: React.CSSProperties = {
    padding: '0.625rem 1rem',
    backgroundColor: 'transparent',
    color: '#5B39F3',
    border: '1px solid #5B39F3',
    borderRadius: '0.375rem',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
    width: '100%',
  };

  /** Style for the panel container when open. */
  const panelStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    padding: '0.75rem',
    backgroundColor: '#F5F5F5',
    border: '1px solid #D9D9D9',
    borderRadius: '0.5rem',
  };

  /** Style for the panel header row. */
  const panelHeaderStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '0.5rem',
  };

  /** Style for the panel header title. */
  const panelHeaderTitleStyle: React.CSSProperties = {
    margin: 0,
    fontSize: '0.75rem',
    color: '#666',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    fontWeight: 600,
  };

  /** Style for the small secondary buttons (Refresh, Close). */
  const headerSecondaryButtonStyle: React.CSSProperties = {
    padding: '0.25rem 0.5rem',
    background: 'transparent',
    color: '#333',
    border: '1px solid #D9D9D9',
    borderRadius: '0.25rem',
    fontSize: '0.75rem',
    cursor: 'pointer',
  };

  /** Style for the <ul> wrapping rows. Resets default list spacing. */
  const listStyle: React.CSSProperties = {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    maxHeight: '24rem',
    overflowY: 'auto',
  };

  /** Style for an individual row (the inner <button>). */
  const rowButtonStyle = (isLoadingRow: boolean, isRecent: boolean): React.CSSProperties => ({
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: '0.125rem',
    padding: '0.5rem 0.625rem',
    backgroundColor: isRecent ? '#F0FDF4' : '#FFFFFF',
    border: isRecent ? '1px solid #BBF7D0' : '1px solid #D9D9D9',
    borderRadius: '0.375rem',
    cursor: isLoadingRow ? 'wait' : 'pointer',
    width: '100%',
    textAlign: 'left',
    fontFamily: 'inherit',
    color: '#333',
  });

  /** Style for the row's title text. */
  const rowTitleStyle: React.CSSProperties = {
    fontSize: '0.875rem',
    fontWeight: 500,
  };

  /** Style for the row's metadata line. */
  const rowMetaStyle: React.CSSProperties = {
    fontSize: '0.75rem',
    color: '#999',
  };

  /** Style for the empty-state message. */
  const emptyStateStyle: React.CSSProperties = {
    padding: '0.75rem',
    fontSize: '0.8125rem',
    color: '#666',
    textAlign: 'center',
  };

  /** Style for the loading indicator inline marker. */
  const loadingIndicatorStyle: React.CSSProperties = {
    padding: '0.5rem',
    fontSize: '0.8125rem',
    color: '#666',
    textAlign: 'center',
  };

  /** Style for the load-more button. */
  const loadMoreButtonStyle: React.CSSProperties = {
    padding: '0.5rem 0.75rem',
    backgroundColor: '#FFFFFF',
    color: '#5B39F3',
    border: '1px solid #5B39F3',
    borderRadius: '0.375rem',
    fontSize: '0.8125rem',
    fontWeight: 500,
    cursor: listState === 'loading' ? 'wait' : 'pointer',
  };

  /** Style for the list-error banner. */
  const listErrorBannerStyle: React.CSSProperties = {
    padding: '0.625rem 0.75rem',
    backgroundColor: '#FFF4F4',
    border: '1px solid #FFB3B3',
    borderRadius: '0.375rem',
    color: '#B00020',
    fontSize: '0.8125rem',
  };

  /** Style for the row-error banner. */
  const rowErrorBannerStyle: React.CSSProperties = {
    padding: '0.625rem 0.75rem',
    backgroundColor: '#FFF4F4',
    border: '1px solid #FFB3B3',
    borderRadius: '0.375rem',
    color: '#B00020',
    fontSize: '0.8125rem',
  };

  // -------------------------------------------------------------------------
  // JSX
  // -------------------------------------------------------------------------
  return (
    <section
      aria-label="Load saved design"
      data-testid="load-design-list"
      className="load-design-list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
    >
      {/*
       * Panel-open trigger — always visible. When the panel is open it
       * toggles back to closed. The aria-expanded reflects state so
       * assistive technology announces the disclosure correctly.
       */}
      <button
        type="button"
        data-testid="load-design-trigger"
        aria-expanded={isOpen}
        aria-controls="load-design-list-panel"
        onClick={handleToggleOpen}
        style={triggerButtonStyle}
      >
        {isOpen ? 'Hide saved designs' : 'Load saved design'}
      </button>

      {/*
       * Panel — shown only when the user has opened it. The panel
       * contains the list, optional Load More, and the (separate) row
       * error banner.
       */}
      {isOpen && (
        <div
          id="load-design-list-panel"
          role="region"
          aria-label="Saved designs"
          style={panelStyle}
        >
          {/*
           * Header row: title + Refresh + Close.
           */}
          <header style={panelHeaderStyle}>
            <h3 style={panelHeaderTitleStyle}>Your saved designs</h3>
            <div style={{ display: 'flex', gap: '0.25rem' }}>
              <button
                type="button"
                data-testid="load-design-list-refresh"
                onClick={() => {
                  void handleRefresh();
                }}
                disabled={listState === 'loading'}
                style={headerSecondaryButtonStyle}
              >
                Refresh
              </button>
              <button
                type="button"
                data-testid="load-design-list-close"
                onClick={handleToggleOpen}
                aria-label="Close saved designs panel"
                style={headerSecondaryButtonStyle}
              >
                Close
              </button>
            </div>
          </header>

          {/*
           * Loading marker — visible during the initial fetch when
           * `items` is empty AND state is 'loading'. After the first
           * page resolves, subsequent Load More fetches show the
           * loading copy below the list (not in place of it).
           */}
          {listState === 'loading' && items.length === 0 && (
            <p
              role="status"
              aria-live="polite"
              data-testid="load-design-list-loading"
              style={loadingIndicatorStyle}
            >
              Loading your saved designs…
            </p>
          )}

          {/*
           * List-error banner — shown when the fetch rejected. Hides the
           * row list to avoid stale data. A Retry button re-issues the
           * fetch.
           */}
          {listState === 'error' && listError !== null && (
            <div
              role="alert"
              aria-live="polite"
              data-testid="load-design-list-error"
              style={listErrorBannerStyle}
            >
              <p style={{ margin: 0 }}>{listError}</p>
              <button
                type="button"
                data-testid="load-design-list-error-retry"
                onClick={handleRetry}
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
                Retry
              </button>
            </div>
          )}

          {/*
           * Empty-state — shown when the fetch succeeded but the user
           * has zero saved designs. Per ST-028-AC3 this is HTTP 200 with
           * an empty array, NOT an error.
           */}
          {listState === 'success' && items.length === 0 && (
            <p
              data-testid="load-design-list-empty"
              style={emptyStateStyle}
            >
              You have no saved designs yet. Use the Save Design button to save your first design.
            </p>
          )}

          {/*
           * Row list — shown whenever there is at least one item. Each
           * row is an accessible <button> inside an <li> for keyboard
           * navigation and screen-reader semantics. Per ST-019-AC4 the
           * server returns items in lastModifiedAt DESC order; we
           * render them in the order received and do NOT re-sort.
           */}
          {items.length > 0 && (
            <ul style={listStyle}>
              {items.map((item) => {
                const isLoadingRow =
                  rowLoad !== null && rowLoad.id === item.id;
                const isRecent = recentlyLoadedId === item.id;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      data-testid="load-design-list-row"
                      data-design-id={item.id}
                      onClick={() => {
                        void handleSelectRow(item.id);
                      }}
                      disabled={rowLoad !== null}
                      aria-busy={isLoadingRow}
                      style={rowButtonStyle(isLoadingRow, isRecent)}
                    >
                      <span
                        data-testid="load-design-list-row-title"
                        style={rowTitleStyle}
                      >
                        {item.title}
                      </span>
                      <span
                        data-testid="load-design-list-row-meta"
                        style={rowMetaStyle}
                      >
                        {isLoadingRow
                          ? rowLoad?.phase === 'issuing-share'
                            ? 'Preparing load…'
                            : 'Loading design…'
                          : isRecent
                            ? `Loaded · ${formatRelativeTime(item.lastModifiedAt)}`
                            : `Last modified ${formatRelativeTime(item.lastModifiedAt)}`}
                      </span>
                      {isLoadingRow && (
                        <span
                          data-testid="load-design-row-loading"
                          style={{ display: 'none' }}
                        />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {/*
           * Loading marker for Load More fetches — shown below the list
           * (so the existing rows remain visible during the fetch).
           */}
          {listState === 'loading' && items.length > 0 && (
            <p
              role="status"
              aria-live="polite"
              data-testid="load-design-list-loading"
              style={loadingIndicatorStyle}
            >
              Loading more…
            </p>
          )}

          {/*
           * Load More button — visible only when there is at least one
           * row AND the backend supplied a non-null nextCursor on the
           * last successful fetch. Disabled while a fetch is in flight.
           */}
          {listState === 'success' && nextCursor !== null && items.length > 0 && (
            <button
              type="button"
              data-testid="load-design-load-more"
              onClick={() => {
                void handleLoadMore();
              }}
              style={loadMoreButtonStyle}
            >
              Load more
            </button>
          )}

          {/*
           * Row-error banner — shown when the share-link round-trip
           * failed. Distinct from the list error so the rows remain
           * visible and the user can pick another design.
           */}
          {rowError !== null && (
            <div
              role="alert"
              aria-live="polite"
              data-testid="load-design-row-error"
              style={rowErrorBannerStyle}
            >
              <p style={{ margin: 0 }}>{rowError}</p>
              <button
                type="button"
                data-testid="load-design-row-error-dismiss"
                onClick={handleDismissRowError}
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
      )}
    </section>
  );
}
