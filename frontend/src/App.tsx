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
 *   - ST-022 — design summary sidebar is read-only and reflects the
 *     current store state.
 *   - QA Report Issues #1 through #11 — every Track 2 control
 *     (ST-006..ST-017) is now mounted inside `<ControlSidebar />`
 *     replacing the previous placeholder paragraph.
 *   - QA Report Issue #12 — `<BallCanvas />` is wrapped in
 *     `<ErrorBoundary />` so a missing WebGL context no longer
 *     unmounts the entire React tree.
 *
 * Track scope:
 *   - This file ships the full SHELL for Track 2 Frontend Core (AAP
 *     §0.6.7). The control sidebar mounts ST-006..ST-017 controls;
 *     the design summary sidebar reads directly from the Zustand
 *     store for ST-022.
 *   - The canonical `useColorSync()` hook is mounted at the App
 *     level. It is the SOLE caller of `texturePipeline.update()` /
 *     `applyConfiguratorState()` from `controls/colors/`, satisfying
 *     the Rule R7 / C6 single-canonical-site requirement.
 *   - Firebase client initialization is intentionally NOT called
 *     here. Per AAP §0.6.9 (Merge Gate 1 — MG1-F Design Mgmt
 *     Integration), Firebase wiring is deferred to that gate so that
 *     Track 2 can render and pass Gate T2 without the
 *     `VITE_FIREBASE_*` environment variables — preserving
 *     ST-001-AC4 (ZERO console errors during initial render) when
 *     the app is run without a `.env`.
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
 *   - Rule R3: no JWT / Firebase Admin imports; the deferred Firebase
 *     CLIENT initialization above is the only auth concern, and is
 *     intentionally omitted at this scope level.
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
import { useConfiguratorStore } from './state/configuratorStore';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable labels for the StitchingPattern enum (ST-010 panel
 * reference). Used by the read-only summary sidebar.
 */
const STITCHING_PATTERN_LABELS: Record<string, string> = {
  classic: 'Classic',
  hexagonal: 'Hexagonal',
  diamond: 'Diamond',
  spiral: 'Spiral',
  star: 'Star',
  grid: 'Grid',
};

/**
 * Human-readable labels for the MaterialFinish enum (ST-011 panel
 * reference). Used by the read-only summary sidebar.
 */
const MATERIAL_FINISH_LABELS: Record<string, string> = {
  matte: 'Matte',
  glossy: 'Glossy',
  metallic: 'Metallic',
};

// ---------------------------------------------------------------------------
// Sub-components (co-located for the Track 2 shell)
// ---------------------------------------------------------------------------

/**
 * The application's top-bar header. Hosts the brand lockup, the
 * configurator title, and a placeholder for the New Design CTA
 * (full ST-020 dialog wiring is co-located with `NewDesignDialog.tsx`,
 * which is created elsewhere in Track 2 / MG1-F).
 */
function AppHeader(): JSX.Element {
  return (
    <header className="app-shell-header" role="banner">
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
    </header>
  );
}

/**
 * Read-only design summary sidebar (ST-022).
 *
 * Subscribes via individual selectors to every slice of the configurator
 * store and renders a labeled summary. CTAs (Save, Add to Cart) live
 * here per AAP §0.6.14 but are wired up in MG1-F; this initial
 * implementation renders a CTA placeholder.
 */
function DesignSummarySidebar(): JSX.Element {
  const primaryColor = useConfiguratorStore((s) => s.primaryColor);
  const secondaryColor = useConfiguratorStore((s) => s.secondaryColor);
  const accentColor = useConfiguratorStore((s) => s.accentColor);
  const stitchingPattern = useConfiguratorStore((s) => s.stitchingPattern);
  const materialFinish = useConfiguratorStore((s) => s.materialFinish);
  const logoFile = useConfiguratorStore((s) => s.logoFile);

  return (
    <aside
      className="app-shell-summary"
      aria-label="Current design summary"
      data-testid="design-summary-sidebar"
    >
      <span className="brand-accent-bar" aria-hidden="true" />
      <span className="brand-eyebrow">Current design</span>

      <SummaryRow label="Primary" value={primaryColor} swatch={primaryColor} />
      <SummaryRow label="Secondary" value={secondaryColor} swatch={secondaryColor} />
      <SummaryRow label="Accent" value={accentColor} swatch={accentColor} />
      <SummaryRow
        label="Pattern"
        value={STITCHING_PATTERN_LABELS[stitchingPattern] ?? stitchingPattern}
      />
      <SummaryRow label="Finish" value={MATERIAL_FINISH_LABELS[materialFinish] ?? materialFinish} />
      <SummaryRow label="Logo" value={logoFile === null ? 'None' : 'Uploaded'} />
    </aside>
  );
}

/**
 * One labeled row in the summary sidebar. The optional `swatch` prop
 * renders a small color square next to the value (used for the three
 * color slices).
 */
function SummaryRow(props: { label: string; value: string; swatch?: string }): JSX.Element {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--space-sm)',
        padding: 'var(--space-sm) 0',
        borderBottom: '1px solid var(--blitzy-border-soft)',
      }}
      data-testid={`summary-row-${props.label.toLowerCase()}`}
    >
      <span
        style={{
          fontSize: '0.75rem',
          color: 'var(--blitzy-text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
          minWidth: '5rem',
        }}
      >
        {props.label}
      </span>
      {props.swatch !== undefined ? (
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: '1rem',
            height: '1rem',
            borderRadius: 'var(--radius-sm)',
            background: props.swatch,
            border: '1px solid var(--blitzy-border-soft)',
            flex: '0 0 auto',
          }}
        />
      ) : null}
      <span
        style={{
          fontSize: '0.875rem',
          color: 'var(--blitzy-text)',
          fontFamily: props.swatch !== undefined ? 'var(--ff-mono)' : 'var(--ff-body)',
          flex: '1 1 auto',
          textAlign: props.swatch !== undefined ? 'left' : 'right',
        }}
        data-testid={`summary-value-${props.label.toLowerCase()}`}
      >
        {props.value}
      </span>
    </div>
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
