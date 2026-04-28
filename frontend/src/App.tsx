/**
 * App — top-level layout shell for the StrikeForge configurator.
 *
 * ============================================================================
 * Authority
 * ============================================================================
 *
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/App.tsx | Top-level layout
 *     assembling preview, controls, sidebar".
 *   - AAP §0.6.14 ("User Interface Design") — three-region layout:
 *     LEFT control sidebar, CENTER live 3D preview, RIGHT design summary
 *     sidebar; top navigation hosts the New Design action and (per
 *     ST-021) the Share action; right region "hosts the Save Design
 *     and Add to Cart CTA anchors per ST-022-AC5".
 *   - ST-001 — sphere renders centered in the available preview area;
 *     the preview region must auto-fit on viewport resize.
 *   - ST-018 — Save Design CTA is mounted in the right summary region
 *     as a sibling of the live summary.
 *   - ST-019 — Load Designs list is mounted in the top navigation.
 *   - ST-020 — New Design reset dialog is mounted in the top navigation.
 *   - ST-021 — Share-link action with clipboard-copy is rendered in
 *     the top navigation per its schema purpose.
 *   - ST-022-AC5 — design summary sidebar HOSTS the Save / Add-to-Cart
 *     anchors. SaveDesignCta is rendered as a sibling of the imported
 *     `DesignSummarySidebar` inside the right summary region (matching
 *     `DesignSummarySidebar`'s own JSDoc directive: "Save Design is
 *     rendered as a sibling component (SaveDesignCta) by the App layout
 *     per AAP §0.6.14"). The Add-to-Cart affordance is provided
 *     INLINE by `DesignSummarySidebar` itself.
 *
 *   - QA Report Issue #6 (MG1-F) — App.tsx imports the dedicated
 *     `DesignSummarySidebar` from `features/design-management/`
 *     instead of redeclaring a local function. The previously-shipped
 *     local sidebar was passive and showed only labels; the imported
 *     sidebar is the canonical AC-compliant component for ST-022.
 *   - QA Report Issues #1, #2, #3, #4 — the four design-management
 *     components (SaveDesignCta, LoadDesignList, NewDesignDialog,
 *     ShareDesignAction) are mounted by this shell in the regions
 *     specified by the AAP.
 *   - QA Report Issue #12 — `<BallCanvas />` is wrapped in
 *     `<ErrorBoundary />` so a missing WebGL context no longer
 *     unmounts the entire React tree.
 *
 * ============================================================================
 * Track scope
 * ============================================================================
 *
 *   - This file ships the full SHELL for Track 2 Frontend Core
 *     (AAP §0.6.7) PLUS the MG1-F design-management wiring
 *     (AAP §0.6.9). The control sidebar mounts ST-006..ST-017 controls;
 *     the design summary sidebar reads directly from the Zustand store
 *     for ST-022 AND is hosted in the same right-side region as the
 *     SaveDesignCta sibling per ST-022-AC5.
 *   - The canonical `useColorSync()` hook is mounted at the App level.
 *     It is the SOLE caller of `texturePipeline.update()` /
 *     `applyConfiguratorState()` from `controls/colors/`, satisfying
 *     the Rule R7 / C6 single-canonical-site requirement.
 *   - Firebase client SDK initialization is invoked once on mount via
 *     `useEffect(() => { initializeFirebaseClient(); }, [])`. The
 *     bootstrap is also performed at module top-level in `main.tsx`
 *     (per QA Issue #7 fix); the additional `useEffect` call in this
 *     component is idempotent (firebase-client.ts has both a
 *     module-private guard and a defense-in-depth `getApps()` check)
 *     and serves as a defensive belt-and-braces guarantee that the
 *     Firebase SDK is initialized regardless of the entry path.
 *   - Performance instrumentation (`window.__strikeforge_perf__`) is
 *     initialized inside `BallCanvas.tsx` so its lifecycle is bound
 *     to the canvas mount, not the App shell.
 *
 * ============================================================================
 * Cross-cutting rules enforced here
 * ============================================================================
 *
 *   - Rule R2 (no credentials in logs): ZERO `console.*` calls. The
 *     `useEffect` hook uses only safe React and Firebase Web SDK
 *     primitives — no token, password, or credential is logged.
 *   - Rule R3 (Firebase Admin SDK is backend-only): this file imports
 *     ONLY the browser-safe `./auth/firebase-client` wrapper, which
 *     itself imports from `firebase` (the JS SDK) and never from
 *     `firebase-admin`, `jsonwebtoken`, `jose`, or `jwt-decode`.
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate` — the
 *     `useColorSync()` hook is the only path from this file to the
 *     pipeline.
 *   - Rule R9 (no payment processing): no payment SDK imports of any
 *     kind; the right sidebar's Add-to-Cart affordance issues a
 *     POST /api/orders that performs server-side state transition
 *     only (no charge, tokenization, or settlement).
 */

import { useEffect } from 'react';
import type { JSX } from 'react';

// ---------------------------------------------------------------------------
// Authentication wiring (post-MG1-F)
// ---------------------------------------------------------------------------
//
// The Firebase JS SDK is initialized at module top-level in `main.tsx`
// (per the QA Issue #7 fix) AND defensively re-initialized inside this
// component's mount-time `useEffect`. The init function is idempotent
// (firebase-client.ts has a module-private guard plus a `getApps()`
// defense-in-depth check), so the double call is safe under both normal
// startup and React StrictMode's double-effect invocation in development.
//
// The `useEffect` call here serves two purposes:
//   1. Schema compliance — App.tsx is the canonical Firebase-init mount
//      site per the AAP §0.6.7 frontend bootstrap sequence.
//   2. Defense-in-depth — if a future refactor drops the main.tsx call,
//      App.tsx still ensures init runs before any child component reads
//      `getIdToken()`.
import { initializeFirebaseClient } from './auth/firebase-client';

// ---------------------------------------------------------------------------
// Subtree-level error boundary (QA Issue #12)
// ---------------------------------------------------------------------------
//
// `<ErrorBoundary>` wraps `<BallCanvas />` so that a WebGL initialization
// failure (no GPU context, browser disabling WebGL, etc.) is contained to
// the preview region rather than unmounting the entire React tree. The
// boundary is implemented as a React 18 class component because
// `getDerivedStateFromError` and `componentDidCatch` are only available
// on class components.
import { ErrorBoundary } from './components/ErrorBoundary';

// ---------------------------------------------------------------------------
// Configurator preview
// ---------------------------------------------------------------------------
import { BallCanvas } from './configurator/preview/BallCanvas';

// ---------------------------------------------------------------------------
// Configurator controls — color pickers
// ---------------------------------------------------------------------------
import { AccentColorPicker } from './configurator/controls/colors/AccentColorPicker';
import { PrimaryColorPicker } from './configurator/controls/colors/PrimaryColorPicker';
import { SecondaryColorPicker } from './configurator/controls/colors/SecondaryColorPicker';

// ---------------------------------------------------------------------------
// Canonical color-sync hook
// ---------------------------------------------------------------------------
//
// Mounting `useColorSync()` at the App level guarantees that the FIFO
// `texturePipeline.update()` chain is owned by exactly one component
// instance and survives any re-render of the control sidebar. Per the
// existing module architecture this is the SOLE call site of
// `useColorSync` in the application; the hook itself is the SOLE caller
// of `applyConfiguratorState`, satisfying the Rule R7 / C6
// single-canonical-site requirement.
import { useColorSync } from './configurator/controls/colors/useColorSync';

// ---------------------------------------------------------------------------
// Configurator controls — pattern + finish + transition feedback + logo
// ---------------------------------------------------------------------------
import { LogoPositioner } from './configurator/controls/logo/LogoPositioner';
import { LogoUploader } from './configurator/controls/logo/LogoUploader';
import { FinishSelector } from './configurator/controls/pattern/FinishSelector';
import { StitchingPatternSelector } from './configurator/controls/pattern/StitchingPatternSelector';
import { TransitionFeedback } from './configurator/controls/pattern/TransitionFeedback';

// ---------------------------------------------------------------------------
// Design-management feature components — mounted by the App shell at MG1-F
// ---------------------------------------------------------------------------
//
// Each component is self-contained and reads its own slice of the
// configurator store via Zustand selectors. Mount-site placement:
//   - Top navigation: NewDesignDialog (ST-020), LoadDesignList (ST-019),
//     ShareDesignAction (ST-021 — explicitly "rendered in the top
//     navigation" per the schema purpose).
//   - Right summary region: DesignSummarySidebar (ST-022) hosts the
//     live summary AND the inline Add-to-Cart anchor; SaveDesignCta
//     (ST-018) is mounted as a SIBLING of DesignSummarySidebar inside
//     the same right-region <aside>, per ST-022-AC5 and per
//     DesignSummarySidebar's own JSDoc directive ("Save Design is
//     rendered as a sibling component by the App layout").
import { DesignSummarySidebar } from './features/design-management/DesignSummarySidebar';
import { LoadDesignList } from './features/design-management/LoadDesignList';
import { NewDesignDialog } from './features/design-management/NewDesignDialog';
import { SaveDesignCta } from './features/design-management/SaveDesignCta';
import { ShareDesignAction } from './features/design-management/ShareDesignAction';

// ---------------------------------------------------------------------------
// Sub-components (co-located with the App shell for clarity)
// ---------------------------------------------------------------------------

/**
 * The application's top-bar header. Hosts the brand lockup, the
 * configurator title, and the global design-management actions:
 * New Design (ST-020), Load Designs (ST-019), and Share Design (ST-021).
 *
 * Layout strategy: the header uses a flex row with
 * `justify-content: space-between` so the brand lockup sits at the
 * leading edge and the action buttons sit at the trailing edge,
 * regardless of viewport width. The action group itself is also a
 * flex row, allowing the buttons to wrap onto a second line on
 * narrow viewports without disturbing the brand area.
 *
 * Accessibility:
 *   - The outer element is `<header role="banner">` — the implicit
 *     `banner` landmark is what screen readers announce.
 *   - The action group is wrapped in `<nav aria-label="Top navigation">`
 *     so the design-management actions are discoverable via the
 *     screen-reader landmarks list.
 *   - The brand area exposes a small `<span class="brand-eyebrow">`
 *     followed by `<h1>` — the page's only `<h1>` per WCAG best
 *     practice (one `<h1>` per page).
 */
function AppHeader(): JSX.Element {
  return (
    <header
      className="app-shell-header"
      role="banner"
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '1rem',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: '0.125rem',
        }}
      >
        <span className="brand-eyebrow">StrikeForge</span>
        <h1
          className="app-shell-header-title"
          style={{
            fontFamily: 'var(--ff-display)',
            fontSize: '1.5rem',
            fontWeight: 600,
            letterSpacing: '-0.01em',
            margin: 0,
          }}
        >
          3D Sports Ball Configurator
        </h1>
      </div>
      <nav
        aria-label="Top navigation"
        className="app-shell-header-actions"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '0.5rem',
          flexWrap: 'wrap',
        }}
        data-testid="app-header-actions"
      >
        {/*
         * NewDesignDialog (ST-020) — renders its own trigger button +
         * inline confirmation modal. Always-enabled per ST-020-AC1.
         */}
        <NewDesignDialog />

        {/*
         * LoadDesignList (ST-019) — renders its own trigger button +
         * inline panel that lists saved designs and selects one to
         * load. The panel is closed by default; clicking the trigger
         * fetches `GET /api/designs` and renders the paginated result.
         */}
        <LoadDesignList />

        {/*
         * ShareDesignAction (ST-021) — renders its own trigger
         * button + inline status panel. Per the schema's purpose
         * ("rendered in the top navigation per ST-021") the share
         * affordance lives in the top nav alongside New Design and
         * Load Designs, NOT inside the right summary sidebar.
         */}
        <ShareDesignAction />
      </nav>
    </header>
  );
}

/**
 * Left control sidebar — mounts every Track 2 control (ST-006..ST-017).
 *
 * The render order matches the documented designer workflow:
 *   1. Color pickers (Primary → Secondary → Accent) — ST-006..ST-008.
 *   2. Stitching pattern selector — ST-010.
 *   3. Material finish selector — ST-011 (with disabled-combination
 *      tooltip rendered inline per ST-013 by the selector itself).
 *   4. Transition feedback indicator — ST-012.
 *   5. Logo uploader (with rejection feedback) — ST-014 + ST-017.
 *   6. Logo positioner — ST-015 + ST-016.
 *
 * Each child is self-contained and reads its own slice from the
 * configurator store. The sidebar itself owns no state.
 */
function ControlSidebar(): JSX.Element {
  return (
    <aside
      className="app-shell-controls"
      aria-label="Configurator controls"
      data-testid="control-sidebar"
    >
      <span className="brand-accent-bar" aria-hidden="true" />
      <span className="brand-eyebrow">Customize</span>

      <PrimaryColorPicker />
      <SecondaryColorPicker />
      <AccentColorPicker />

      <StitchingPatternSelector />
      <FinishSelector />
      <TransitionFeedback />

      <LogoUploader />
      <LogoPositioner />
    </aside>
  );
}

/**
 * Right summary sidebar — hosts the live design summary panel
 * (`DesignSummarySidebar`, ST-022) and the Save Design CTA
 * (`SaveDesignCta`, ST-018) as siblings inside a single
 * `<aside class="app-shell-summary">` grid-area-summary anchor.
 *
 * Per ST-022-AC5 the right summary region hosts the Save Design and
 * Add-to-Cart anchors:
 *   - SaveDesignCta is mounted here as a sibling of the summary panel,
 *     consistent with `DesignSummarySidebar`'s JSDoc directive
 *     ("Save Design is rendered as a sibling component (`SaveDesignCta`)
 *     by the App layout per AAP §0.6.14").
 *   - The Add-to-Cart affordance is provided INLINE by
 *     `DesignSummarySidebar` itself.
 *
 * The wrapping `<aside>` declares `class="app-shell-summary"` so it
 * lands in the CSS-Grid `summary` area defined by `global.css`.
 * `aria-label="Design summary and primary actions"` makes the entire
 * region (summary + CTA) discoverable as a single landmark for
 * assistive technology.
 */
function SummarySidebar(): JSX.Element {
  return (
    <aside
      className="app-shell-summary"
      aria-label="Design summary and primary actions"
      data-testid="summary-sidebar"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '1rem',
      }}
    >
      <DesignSummarySidebar />
      <SaveDesignCta />
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Main App component
// ---------------------------------------------------------------------------

/**
 * The application root. Composes the four-region layout
 * (header / controls / preview / summary).
 *
 * The `app-shell` class declares the CSS Grid in `global.css`, which
 * collapses to a single column at the documented mobile breakpoint
 * (≤900px). All region styling is owned by `global.css` — this
 * component supplies only structure.
 *
 * The `useColorSync()` hook is invoked at this component's render so
 * its `useEffect` registrations live for the lifetime of the App. It
 * is the SOLE call site of `useColorSync` in the application, ensuring
 * the texture pipeline is owned by exactly one subscription chain
 * (Rule R7 / C6).
 *
 * The `useEffect(() => { initializeFirebaseClient(); }, [])` hook
 * provides defensive Firebase initialization at App mount time. The
 * primary initialization path is `main.tsx` (synchronous, before
 * `createRoot().render()`); the call here is a belt-and-braces
 * guarantee that survives future refactors. `initializeFirebaseClient`
 * is idempotent (module-private guard + `getApps()` defense-in-depth),
 * so the double call is safe under both normal startup and React
 * StrictMode's double-effect invocation in development.
 *
 * Returns: a single `<div class="app-shell">` containing
 * `<AppHeader />`, `<ControlSidebar />`, `<main class="app-shell-preview">`
 * (with `<BallCanvas />` inside an `<ErrorBoundary>`), and
 * `<SummarySidebar />`. The `JSX.Element` return type matches the
 * schema's exports contract for the `App` named function export.
 */
export function App(): JSX.Element {
  // -------------------------------------------------------------------------
  // Mount the canonical color-sync hook at the App level.
  //
  // Per the existing module architecture this is the SOLE call site of
  // `useColorSync` in the application; the hook itself is the SOLE
  // caller of `applyConfiguratorState` (and therefore of the texture
  // pipeline) from `controls/colors/`, satisfying the Rule R7 / C6
  // single-canonical-site requirement. The hook returns nothing — its
  // effect-driven subscription is established for the lifetime of the
  // App component.
  // -------------------------------------------------------------------------
  useColorSync();

  // -------------------------------------------------------------------------
  // Mount-time Firebase client SDK initialization (post-MG1-F).
  //
  // The empty dependency array ensures the call runs exactly once after
  // the initial mount. `initializeFirebaseClient` is idempotent and
  // StrictMode-safe (see `auth/firebase-client.ts` for the
  // module-private guard and the `getApps()` check). Calling it here
  // is intentional defense-in-depth: even if a future refactor drops
  // the synchronous call from `main.tsx`, the SDK is still initialized
  // before any child component invokes `getIdToken()` (which only
  // happens AFTER mount, when the user triggers an authenticated
  // action such as Save Design or Create Order).
  //
  // Errors thrown by `initializeFirebaseClient` (missing
  // `VITE_FIREBASE_*` configuration) bubble to React's nearest error
  // boundary. Because the synchronous call in `main.tsx` runs first,
  // any configuration error surfaces there before this `useEffect`
  // ever executes — keeping the user-facing error UX consistent.
  // -------------------------------------------------------------------------
  useEffect(() => {
    initializeFirebaseClient();
  }, []);

  return (
    <div className="app-shell" data-testid="app-shell">
      <AppHeader />
      <ControlSidebar />
      <main
        className="app-shell-preview"
        role="main"
        aria-label="Live 3D ball preview"
        data-testid="preview-region"
      >
        {/*
         * Wrap `<BallCanvas />` in an `<ErrorBoundary>` (QA Issue #12).
         * When WebGL is unavailable — e.g., a headless browser without
         * GPU acceleration or a user-disabled context — the boundary
         * catches the throw and renders a brand-styled fallback while
         * the rest of the layout (header, control sidebar, summary)
         * remains interactive.
         */}
        <ErrorBoundary aria-label="3D preview unavailable" data-testid="preview-error-boundary">
          <BallCanvas />
        </ErrorBoundary>
      </main>
      <SummarySidebar />
    </div>
  );
}
