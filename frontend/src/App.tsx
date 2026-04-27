/**
 * App — top-level layout shell for the StrikeForge configurator.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/App.tsx | Top-level layout
 *     assembling preview, controls, sidebar".
 *   - AAP §0.6.14 ("User Interface Design") — three-region layout:
 *     LEFT control sidebar, CENTER live 3D preview, RIGHT design
 *     summary sidebar; top navigation hosts the New Design action.
 *   - ST-001 — sphere renders centered in the available preview area;
 *     the preview region must auto-fit on viewport resize.
 *   - ST-018, ST-019, ST-020, ST-021 — design management actions
 *     (Save, Load, New, Share) are mounted by this shell into either
 *     the top-navigation header (New Design + Load Designs) or the
 *     design summary sidebar (Save + Add to Cart + Share).
 *   - ST-022 — design summary sidebar reflects the current store
 *     state and HOSTS the Save / Add-to-Cart / Share inline anchors
 *     per ST-022-AC5.
 *   - QA Report Issue #6 (MG1-F) — App.tsx now imports the dedicated
 *     `DesignSummarySidebar` from `features/design-management/`
 *     instead of redeclaring a local function. The previously-shipped
 *     local sidebar was passive and showed only labels; the imported
 *     sidebar HOSTS Save / Add-to-Cart / Share CTAs as required by
 *     ST-022-AC5.
 *   - QA Report Issues #1, #2, #3, #4 — the four missing design-mgmt
 *     components (SaveDesignCta, LoadDesignList, NewDesignDialog,
 *     ShareDesignAction) are now created and mounted by this shell.
 *   - QA Report Issue #12 — `<BallCanvas />` is wrapped in
 *     `<ErrorBoundary />` so a missing WebGL context no longer
 *     unmounts the entire React tree.
 *
 * Track scope:
 *   - This file ships the full SHELL for Track 2 Frontend Core (AAP
 *     §0.6.7) PLUS the MG1-F design-management wiring (AAP §0.6.9).
 *     The control sidebar mounts ST-006..ST-017 controls; the design
 *     summary sidebar (imported from features/design-management)
 *     reads directly from the Zustand store for ST-022 AND hosts the
 *     Save/Add-to-Cart/Share actions.
 *   - The canonical `useColorSync()` hook is mounted at the App
 *     level. It is the SOLE caller of `texturePipeline.update()` /
 *     `applyConfiguratorState()` from `controls/colors/`, satisfying
 *     the Rule R7 / C6 single-canonical-site requirement.
 *   - Firebase client initialization is performed in
 *     `main.tsx` BEFORE `createRoot().render(<App />)` per QA Issue
 *     #7 fix. This file therefore does NOT call
 *     `initializeFirebaseClient()` itself; the auth state is already
 *     ready when App mounts.
 *   - Performance instrumentation (`window.__strikeforge_perf__`) is
 *     initialized inside `BallCanvas.tsx` so its lifecycle is bound
 *     to the canvas mount, not the App shell.
 *
 * Cross-cutting rules:
 *   - Rule R7 / C6: this file does NOT call any texture-pipeline
 *     function and does NOT touch `texture.needsUpdate` — the
 *     `useColorSync()` hook is the only path from this file to the
 *     pipeline.
 *   - Rule R2: ZERO `console.*` calls.
 *   - Rule R3: no JWT / Firebase Admin imports; the auth tokens are
 *     fetched by `firebase-client.ts` (Firebase JS SDK only) and
 *     attached to outbound requests by `api/client.ts`.
 */

import type { JSX } from 'react';

import { ErrorBoundary } from './components/ErrorBoundary';
import { AccentColorPicker } from './configurator/controls/colors/AccentColorPicker';
import { PrimaryColorPicker } from './configurator/controls/colors/PrimaryColorPicker';
import { SecondaryColorPicker } from './configurator/controls/colors/SecondaryColorPicker';
import { useColorSync } from './configurator/controls/colors/useColorSync';
import { LogoPositioner } from './configurator/controls/logo/LogoPositioner';
import { LogoUploader } from './configurator/controls/logo/LogoUploader';
import { FinishSelector } from './configurator/controls/pattern/FinishSelector';
import { StitchingPatternSelector } from './configurator/controls/pattern/StitchingPatternSelector';
import { TransitionFeedback } from './configurator/controls/pattern/TransitionFeedback';
import { BallCanvas } from './configurator/preview/BallCanvas';
// Design management feature components — mounted by the App shell at
// MG1-F per QA Issue #6 ("App.tsx renders a LOCAL inline
// DesignSummarySidebar() function instead of importing the dedicated
// component"). Each component is self-contained and reads its own
// slice of the configurator store via Zustand selectors.
import { DesignSummarySidebar } from './features/design-management/DesignSummarySidebar';
import { LoadDesignList } from './features/design-management/LoadDesignList';
import { NewDesignDialog } from './features/design-management/NewDesignDialog';

// ---------------------------------------------------------------------------
// Sub-components (co-located for the Track 2 shell)
// ---------------------------------------------------------------------------

/**
 * The application's top-bar header. Hosts the brand lockup, the
 * configurator title, and the New Design + Load Designs CTAs.
 *
 * QA Report Issue #3 (ST-020) — the previously-shipped header had a
 * placeholder paragraph where the New Design CTA should have been;
 * this header now mounts the dedicated `NewDesignDialog` component
 * which owns the trigger button AND its confirmation modal.
 *
 * QA Report Issue #2 (ST-019) — the Load Designs CTA + panel is
 * mounted via `LoadDesignList`. The component is closed by default
 * and opens a panel that lists the user's saved designs.
 *
 * Both controls are right-aligned in the header; the brand lockup
 * and title remain left-aligned. The header uses a flex layout with
 * `justify-content: space-between` so the brand area and the action
 * area sit at opposite ends regardless of viewport width.
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
      <div
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
         * fetches /api/designs.
         */}
        <LoadDesignList />
      </div>
    </header>
  );
}

/**
 * Left control sidebar — mounts every Track 2 control (ST-006..ST-017).
 *
 * The render order matches the documented designer workflow:
 *   1. Color pickers (Primary → Secondary → Accent) — ST-006..ST-008.
 *   2. Stitching pattern selector — ST-010.
 *   3. Material finish selector with disabled-combination tooltip —
 *      ST-011 + ST-013.
 *   4. Transition feedback indicator — ST-012.
 *   5. Logo uploader (with rejection feedback) — ST-014 + ST-017.
 *   6. Logo positioner — ST-015 + ST-016.
 *
 * Each child is self-contained and reads its own slice from the
 * configurator store. The sidebar itself owns no state.
 *
 * The previous QA finding (Issue #1) reported this region was a
 * placeholder paragraph; that has been replaced by the real controls.
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

// ---------------------------------------------------------------------------
// Main App component
// ---------------------------------------------------------------------------

/**
 * The application root. Composes the three-region layout
 * (header / controls / preview / summary).
 *
 * The `app-shell` class declares the CSS Grid in `global.css`, which
 * collapses to a single column at the documented mobile breakpoint
 * (≤900px). All region styling is owned by `global.css` — this
 * component supplies only structure.
 */
export default function App(): JSX.Element {
  // Mount the canonical color-sync hook at the App level so that:
  //   - the FIFO `texturePipeline.update()` chain is owned by exactly
  //     one component instance,
  //   - the chain survives any re-renders inside the control sidebar.
  // This is the SOLE call site of `useColorSync` in the application;
  // the hook itself is the SOLE caller of `applyConfiguratorState`
  // (and therefore of the texture pipeline) from `controls/colors/`,
  // satisfying the Rule R7 / C6 single-canonical-site requirement.
  useColorSync();

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
      <DesignSummarySidebar />
    </div>
  );
}
