/**
 * Zustand global state store for the StrikeForge configurator.
 *
 * Authority: AAP §0.3.4, §0.6.7, §0.4.2 (zustand ^4.5.5).
 *
 * Holds ALL configurator UI state (color/pattern/finish/logo/save/load
 * slices) and is the SINGLE source of truth for documented default state
 * applied at ST-001 (initial render), ST-019 (load-failure fallback), and
 * ST-020 (New Design reset).
 *
 * Story coverage:
 *   ST-001 initial render          → initial state from CONFIGURATOR_DEFAULTS
 *   ST-006 / ST-007 / ST-008       → primary/secondary/accent color setters
 *   ST-009 real-time color sync    → selector subscriptions on color slices
 *   ST-010 stitching pattern       → stitchingPattern + setStitchingPattern
 *   ST-011 material finish         → materialFinish + setMaterialFinish
 *   ST-014 / ST-015 / ST-016       → logoFile / logoPosition / logoScale setters
 *   ST-018 save CTA                → isSaved / savedDesignId / lastSavedAt + markSaved
 *   ST-019 load design             → loadedDesign + loadDesign
 *   ST-020 new design reset        → resetToDefaults
 *   ST-022 summary sidebar         → all slices read-only via selectors
 *
 * Cross-cutting rules:
 *   - Rule R2: NO credential material in state. Firebase manages tokens
 *     internally via IndexedDB; the API client retrieves them on-demand.
 *   - Rule R3: NO imports of `firebase`, `firebase-admin`, `jsonwebtoken`,
 *     `jose`, or `jwt-decode` — credentials never live in the store.
 *
 * Design constraints:
 *   - Zustand 4.x named import `create` (NOT the deprecated default).
 *   - NO middleware (`persist`, `devtools`, `subscribeWithSelector`, `immer`).
 *   - NO localStorage / sessionStorage — saving is an explicit user action
 *     via the backend API; persisting drafts would break ST-020 reset.
 *   - NO direct import of the texture pipeline (avoids circular deps);
 *     consumer components call `texturePipeline.update()` after each setter.
 *   - Components MUST subscribe via selectors, never to the whole store.
 */

import { create } from 'zustand';

// ---------------------------------------------------------------------------
// Type definitions
// ---------------------------------------------------------------------------

/** A 6-digit hexadecimal color string with leading `#` (e.g. `'#FF0000'`). */
export type HexColor = string;

/**
 * The six stitching pattern options (ST-010-AC1: Classic, Hexagonal,
 * Diamond, Spiral, Star, Grid).
 */
export type StitchingPattern = 'classic' | 'hexagonal' | 'diamond' | 'spiral' | 'star' | 'grid';

/** The three material finish options (ST-011-AC1: Matte, Glossy, Metallic). */
export type MaterialFinish = 'matte' | 'glossy' | 'metallic';

/**
 * 2D coordinates in normalized panel space, where `(0, 0)` is the panel
 * center. ST-015-AC3 clamps user input to panel boundaries before invoking
 * `setLogoPosition`; the type itself does not enforce a range.
 */
export interface LogoPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * The uploaded logo image source.
 *   - `File`: a freshly-picked browser File reference (consumed via
 *     `URL.createObjectURL()` by the texture pipeline).
 *   - `string`: a remote URL (HTTP(S) or signed GCS URL) from a
 *     previously-saved design loaded via `loadDesign`.
 *   - `null`: no logo applied.
 */
export type LogoFile = File | string | null;

/**
 * Payload accepted by `loadDesign(...)`. Mirrors the design row shape
 * returned by the backend `/api/designs/:id` and `/api/share/:token`
 * endpoints.
 */
export interface LoadedDesignPayload {
  readonly id: string;
  readonly title: string;
  readonly primaryColor: HexColor;
  readonly secondaryColor: HexColor;
  readonly accentColor: HexColor;
  readonly stitchingPattern: StitchingPattern;
  readonly materialFinish: MaterialFinish;
  readonly logoUrl: string | null;
  readonly logoPosition: LogoPosition;
  readonly logoScale: number;
  /** ISO 8601 timestamp string assigned by the backend. */
  readonly lastModifiedAt: string;
}

// ---------------------------------------------------------------------------
// Store state interface
// ---------------------------------------------------------------------------

/**
 * The full Zustand configurator store shape (state + actions).
 *
 * Subscribe via SELECTORS — never to the whole store object — to avoid
 * unnecessary re-renders during high-frequency updates (e.g. logo drag):
 *
 *   const primary = useConfiguratorStore((s) => s.primaryColor);
 *   const setPrimary = useConfiguratorStore((s) => s.setPrimaryColor);
 *
 * Action references are stable across re-renders (Zustand 4.x guarantee),
 * so consumers can include them in `useEffect` dependency arrays.
 */
export interface ConfiguratorState {
  // ---- Color slice (ST-006, ST-007, ST-008, ST-009) ----
  readonly primaryColor: HexColor;
  readonly secondaryColor: HexColor;
  readonly accentColor: HexColor;

  // ---- Pattern / finish slice (ST-010, ST-011) ----
  readonly stitchingPattern: StitchingPattern;
  readonly materialFinish: MaterialFinish;

  // ---- Logo slice (ST-014, ST-015, ST-016) ----
  readonly logoFile: LogoFile;
  readonly logoPosition: LogoPosition;
  readonly logoScale: number;

  // ---- Save slice (ST-018) ----
  /** True iff current state matches the most-recently saved/loaded/reset state. */
  readonly isSaved: boolean;
  /** Server-assigned UUID of the persisted design, or undefined if never saved. */
  readonly savedDesignId: string | undefined;
  /** Epoch milliseconds of the last save, or undefined if never saved. */
  readonly lastSavedAt: number | undefined;

  // ---- Loaded design slice (ST-019) ----
  /** Full payload of the currently-loaded design, or null if none was loaded. */
  readonly loadedDesign: LoadedDesignPayload | null;

  // ---- Color setters ----
  setPrimaryColor: (color: HexColor) => void;
  setSecondaryColor: (color: HexColor) => void;
  setAccentColor: (color: HexColor) => void;

  // ---- Pattern / finish setters ----
  setStitchingPattern: (pattern: StitchingPattern) => void;
  setMaterialFinish: (finish: MaterialFinish) => void;

  // ---- Logo setters ----
  setLogoFile: (file: LogoFile) => void;
  setLogoPosition: (position: LogoPosition) => void;
  setLogoScale: (scale: number) => void;

  /**
   * Mark the current design state as saved (called by `SaveDesignCta` after
   * the backend POST/PUT `/api/designs` returns). Sets `isSaved=true`,
   * `savedDesignId=designId`, `lastSavedAt=Date.now()`.
   */
  markSaved: (designId: string) => void;

  /**
   * Replace ALL state with a previously-saved design payload (ST-019-AC2).
   * After invocation: every slice equals the payload, `isSaved=true`
   * (ST-019-AC4), `savedDesignId=payload.id`,
   * `lastSavedAt=Date.parse(payload.lastModifiedAt)` (with `Date.now()`
   * fallback on parse failure), and `loadedDesign` holds the full payload.
   */
  loadDesign: (payload: LoadedDesignPayload) => void;

  /**
   * Reset every configurator surface to documented defaults (ST-020-AC3).
   * After invocation: every slice equals CONFIGURATOR_DEFAULTS,
   * `isSaved=true`, `savedDesignId=undefined`, `lastSavedAt=undefined`,
   * `loadedDesign=null`. SINGLE source of truth for "default state".
   */
  resetToDefaults: () => void;
}

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/**
 * Documented default configurator state — the SINGLE source of truth applied
 * at ST-001 (initial render), ST-019 (load-failure fallback), and ST-020
 * (New Design reset). `as const` makes the object deeply readonly.
 * Re-exported below as CONFIGURATOR_DEFAULTS.
 */
const DEFAULTS = {
  primaryColor: '#FFFFFF' as HexColor, // White
  secondaryColor: '#000000' as HexColor, // Black
  accentColor: '#FF0000' as HexColor, // Red accent
  stitchingPattern: 'classic' as StitchingPattern,
  materialFinish: 'matte' as MaterialFinish,
  logoFile: null as LogoFile,
  logoPosition: { x: 0, y: 0 } as LogoPosition,
  logoScale: 1.0,
  // Pristine defaults are by definition "saved" — Save CTA stays disabled
  // at first render per ST-018-AC1 because there are no unsaved changes.
  isSaved: true,
  savedDesignId: undefined as string | undefined,
  lastSavedAt: undefined as number | undefined,
  loadedDesign: null as LoadedDesignPayload | null,
} as const;

// ---------------------------------------------------------------------------
// Zustand store
// ---------------------------------------------------------------------------

/**
 * The configurator's global state hook. Components subscribe via selectors:
 *
 *   const primary = useConfiguratorStore((s) => s.primaryColor);
 *   const setPrimary = useConfiguratorStore((s) => s.setPrimaryColor);
 *
 * No `<Provider>` wrapper is required. Imperative access via
 * `useConfiguratorStore.getState() / .setState() / .subscribe() / .destroy()`.
 *
 * Every non-save setter flips `isSaved: false` so ST-018-AC1's "Save CTA
 * enabled whenever the design has unsaved changes" holds without per-component
 * bookkeeping. `markSaved`, `loadDesign`, and `resetToDefaults` each set
 * `isSaved: true` because they restore a saved-or-pristine state.
 */
export const useConfiguratorStore = create<ConfiguratorState>()((set) => ({
  // Initial state seeded from DEFAULTS
  primaryColor: DEFAULTS.primaryColor,
  secondaryColor: DEFAULTS.secondaryColor,
  accentColor: DEFAULTS.accentColor,
  stitchingPattern: DEFAULTS.stitchingPattern,
  materialFinish: DEFAULTS.materialFinish,
  logoFile: DEFAULTS.logoFile,
  logoPosition: DEFAULTS.logoPosition,
  logoScale: DEFAULTS.logoScale,
  isSaved: DEFAULTS.isSaved,
  savedDesignId: DEFAULTS.savedDesignId,
  lastSavedAt: DEFAULTS.lastSavedAt,
  loadedDesign: DEFAULTS.loadedDesign,

  // Color setters (ST-006 / ST-007 / ST-008)
  setPrimaryColor: (color) => set({ primaryColor: color, isSaved: false }),
  setSecondaryColor: (color) => set({ secondaryColor: color, isSaved: false }),
  setAccentColor: (color) => set({ accentColor: color, isSaved: false }),

  // Pattern / finish setters (ST-010 / ST-011)
  setStitchingPattern: (pattern) => set({ stitchingPattern: pattern, isSaved: false }),
  setMaterialFinish: (finish) => set({ materialFinish: finish, isSaved: false }),

  // Logo setters (ST-014 / ST-015 / ST-016)
  setLogoFile: (file) => set({ logoFile: file, isSaved: false }),
  setLogoPosition: (position) => set({ logoPosition: position, isSaved: false }),
  setLogoScale: (scale) => set({ logoScale: scale, isSaved: false }),

  // Save / load / reset actions
  markSaved: (designId) => set({ isSaved: true, savedDesignId: designId, lastSavedAt: Date.now() }),

  loadDesign: (payload) =>
    set({
      primaryColor: payload.primaryColor,
      secondaryColor: payload.secondaryColor,
      accentColor: payload.accentColor,
      stitchingPattern: payload.stitchingPattern,
      materialFinish: payload.materialFinish,
      logoFile: payload.logoUrl,
      logoPosition: payload.logoPosition,
      logoScale: payload.logoScale,
      isSaved: true,
      savedDesignId: payload.id,
      // Date.parse → NaN on invalid input; NaN is falsy so the `||`
      // short-circuits to a safe fallback rather than poisoning state.
      lastSavedAt: Date.parse(payload.lastModifiedAt) || Date.now(),
      loadedDesign: payload,
    }),

  resetToDefaults: () =>
    set({
      primaryColor: DEFAULTS.primaryColor,
      secondaryColor: DEFAULTS.secondaryColor,
      accentColor: DEFAULTS.accentColor,
      stitchingPattern: DEFAULTS.stitchingPattern,
      materialFinish: DEFAULTS.materialFinish,
      logoFile: DEFAULTS.logoFile,
      logoPosition: DEFAULTS.logoPosition,
      logoScale: DEFAULTS.logoScale,
      isSaved: DEFAULTS.isSaved,
      savedDesignId: DEFAULTS.savedDesignId,
      lastSavedAt: DEFAULTS.lastSavedAt,
      loadedDesign: DEFAULTS.loadedDesign,
    }),
}));

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

/**
 * Documented default configurator state, exposed to consumers that need to
 * read defaults without subscribing to the store (texture pipeline init,
 * summary-sidebar helpers, unit tests).
 */
export { DEFAULTS as CONFIGURATOR_DEFAULTS };
