/**
 * Post-MG1-F state of the api stub module — documented default constants for
 * the StrikeForge configurator's New Design Reset (ST-020) and Design Summary
 * Sidebar (ST-022) features.
 *
 * Authority
 * ---------
 *   - AAP §0.6.7 (Track 2 — Frontend Core):
 *       CREATE | `frontend/src/api/stub.ts` | Stub/mock API layer used by
 *       ST-020 and ST-022 until MG1-F.
 *   - AAP §0.6.9 (Merge Gate 1, Step F — Design Management Integration):
 *       MODIFY | `frontend/src/api/stub.ts` | Remove ST-018/ST-019/ST-021
 *       stubs; retain ST-020/ST-022 deliverables if any remain.
 *
 * History
 * -------
 * During Track 2 (per AAP §0.6.7), this file contained mock implementations
 * of `createDesign()` (ST-018), `listDesigns()` (ST-019), and
 * `createShareLink()` (ST-021) so that the design-management UI components
 * could be developed against deterministic fake data before the backend was
 * live.
 *
 * At MG1-F (per AAP §0.6.9), those mock function bodies were removed because
 * the live calls now go through `client.ts` → `designs.ts` (createDesign,
 * listDesigns, createShareLink) and `client.ts` → `orders.ts` (getCart,
 * createOrder, finalizeOrder).
 *
 * What remains (and why this file MUST exist post-MG1-F)
 * ------------------------------------------------------
 * The "documented default values" for every configurator surface, named
 * explicitly by ST-020-AC3:
 *
 *     "Confirming the prompt resets every configurator surface — preview,
 *      color pickers, pattern selector, finish selector, logo controls, and
 *      summary sidebar — to the documented default values."
 *
 * The two constants exported from this file ARE that documentation:
 *
 *   - `DEFAULT_DESIGN_PAYLOAD` — the canonical default {@link DesignPayload}
 *     applied when the user confirms New Design (ST-020) or, in early-render
 *     paths, before the user has interacted with any control.
 *   - `DEFAULT_DESIGN_TITLE` — the canonical default human-readable design
 *     title used by ST-020's New Design dialog when seeding the freshly-reset
 *     state. Components that surface a save dialog may override this with a
 *     more contextual placeholder, but this constant is the documented
 *     fallback.
 *
 * The AAP directive at MG1-F is MODIFY (not DELETE) — therefore the file
 * remains and exports at least one symbol so that the TypeScript compiler
 * still recognizes it as a module reachable from the workspace's `include`
 * patterns.
 *
 * Cross-cutting rules enforced here
 * ---------------------------------
 *   - Rule R2 (no credentials in logs). This file contains ZERO `console.*`
 *     calls and ZERO credential material in any string literal. The only
 *     string values present are documented defaults (`'#FFFFFF'`,
 *     `'#000000'`, `'#FF0000'`, `'classic'`, `'matte'`, and
 *     `'Untitled Design'`).
 *   - Rule R3 (Firebase Admin SDK only on backend). This file imports NO
 *     authentication libraries and NO JWT-handling libraries. Defaults
 *     are pure data — there is nothing to authenticate.
 *   - Rule R9 (no payment processing). This file imports NO payment-
 *     processor SDK and contains NO field names associated with downstream
 *     financial transactions.
 *
 * Out of scope (intentional NON-content)
 * --------------------------------------
 *   - NO mock implementations of `createDesign` / `listDesigns` /
 *     `createShareLink` (now live in `./designs`).
 *   - NO mock implementations of `getCart` / `createOrder` /
 *     `finalizeOrder` (now live in `./orders`).
 *   - NO imports from `./client` — this module performs no API calls.
 *   - NO localization strings — `DEFAULT_DESIGN_TITLE` is a hardcoded
 *     English fallback per the 49-story scope; localization is out of
 *     scope.
 *   - NO timestamp or random ID generation — defaults must be
 *     deterministic. Server-assigned identifiers and timestamps are
 *     created by the backend at insert time per ST-027.
 *   - NO default cart contents or default order state — those are
 *     server-owned constructs.
 *
 * Cross-file coordination
 * -----------------------
 *   - The `pattern: 'classic'` default MUST match the canonical first
 *     stitching pattern declared by `frontend/src/configurator/controls/
 *     pattern/patternCatalog.ts` (`STITCHING_PATTERNS[0].value`). The
 *     existing `frontend/src/state/configuratorStore.ts` `DEFAULTS`
 *     constant uses the same value, confirming the alignment.
 *   - The `finish: 'matte'` default MUST match one of the three documented
 *     identifiers (`'matte'`, `'glossy'`, `'metallic'`) declared by ST-011
 *     and the finish catalog; `'matte'` is documented as the
 *     lowest-reflectivity safe default and matches the existing store's
 *     `DEFAULTS.materialFinish`.
 *   - The hex color defaults match the existing
 *     `frontend/src/state/configuratorStore.ts` `DEFAULTS` constant
 *     (white / black / red), keeping the documented surface consistent
 *     across modules.
 *
 * @see frontend/src/api/designs.ts                              — canonical DesignPayload type
 * @see frontend/src/state/configuratorStore.ts                  — runtime configurator state with the same default values
 * @see frontend/src/features/design-management/NewDesignDialog.tsx (ST-020) — primary consumer of these constants
 * @see frontend/src/features/design-management/DesignSummarySidebar.tsx (ST-022) — renders the documented defaults after a reset
 */

// ----------------------------------------------------------------------------
// Imports
// ----------------------------------------------------------------------------
//
// `DesignPayload` is imported as a TYPE-ONLY import because:
//
//   1. Compile-time shape check — TypeScript verifies that
//      `DEFAULT_DESIGN_PAYLOAD` conforms to the canonical wire shape
//      consumed by `./designs.ts` `createDesign()` (ST-018) and the
//      backend's POST /api/designs endpoint (ST-027). Any future
//      change to `DesignPayload` (e.g., a new required field) flags
//      this file at compile time so the documented default cannot
//      drift silently from the schema.
//
//   2. Zero runtime cost — TypeScript erases type-only imports during
//      compilation, so this file emits NO runtime dependency on
//      `./designs.ts` (which itself imports `./client` which imports
//      Firebase). A runtime import would couple the documented-defaults
//      module to the entire authenticated HTTP stack — defeating its
//      purpose as a lightweight constants module that can be safely
//      pulled into ANY component, including pure unit tests with no
//      Firebase mocking.
//
//   3. ESLint `@typescript-eslint/consistent-type-imports` rule is
//      enabled (see `.eslintrc.json`) and prefers `import type {…}` for
//      types-only consumption, so this is the lint-clean form.
//
import type { DesignPayload } from './designs';

// ----------------------------------------------------------------------------
// Default design payload (ST-020-AC3 "documented default values")
// ----------------------------------------------------------------------------

/**
 * The canonical default {@link DesignPayload} applied when:
 *
 *   - The user confirms the New Design action (ST-020) — every
 *     configurator surface (preview, color pickers, pattern selector,
 *     finish selector, logo controls, and summary sidebar) is reset to
 *     these values per ST-020-AC3.
 *   - A test asserts that a freshly-initialised configurator matches the
 *     documented baseline.
 *   - A consumer needs an unambiguous "blank slate" payload to compare
 *     against the current state (e.g., to determine whether to surface a
 *     "discard unsaved changes" prompt).
 *
 * Field rationale (each value is the documented default):
 *
 *   - `primaryColor: '#FFFFFF'` — white, the most neutral starting color
 *     for the dominant panel area; matches the existing configurator
 *     store's `DEFAULTS.primaryColor`.
 *   - `secondaryColor: '#000000'` — black, a maximum-contrast complement
 *     to white that ensures the secondary surface is visible against the
 *     primary at the very first frame.
 *   - `accentColor: '#FF0000'` — red, a saturated accent that is
 *     immediately distinct from both primary and secondary so users can
 *     identify the accent surface during their first interaction with
 *     the configurator.
 *   - `pattern: 'classic'` — the canonical first entry of the six
 *     documented stitching patterns from ST-010 (declared as
 *     `STITCHING_PATTERNS[0]` in `patternCatalog.ts`). "Classic" is the
 *     traditional crosshatch lacing and is compatible with all three
 *     finishes (no entry in the disabled-combinations matrix).
 *   - `finish: 'matte'` — one of the three documented finishes from
 *     ST-011 (`'matte' | 'glossy' | 'metallic'`); selected as the safe,
 *     lowest-reflectivity default that is compatible with every pattern.
 *   - `logo: null` — no logo applied. Per ST-014 the logo is opt-in via
 *     upload, and per the {@link DesignPayload} contract `null` is
 *     semantically distinct from "logo applied with default placement".
 *     Resetting to `null` ensures no stale {@link DesignLogo} from a
 *     prior design carries over after a New Design action.
 *
 * Mutability:
 *   The constant is exported with the explicit type `DesignPayload`
 *   (not `as const`) so callers can spread it into mutable copies for
 *   state updates — e.g.,
 *     `useConfiguratorStore.setState({ ...DEFAULT_DESIGN_PAYLOAD })`.
 *   Adding `as const` would narrow each property to a string-literal
 *   type, breaking that assignability against the canonical mutable
 *   `DesignPayload` shape used by the Zustand store and the
 *   {@link createDesign} request body.
 *
 *   Although the binding is exported as `const`, downstream code MUST
 *   NOT mutate this object in place. Always copy via spread (`{ ... }`)
 *   when seeding mutable state. Mutating a shared module-scoped default
 *   would corrupt every subsequent reset.
 */
export const DEFAULT_DESIGN_PAYLOAD: DesignPayload = {
  primaryColor: '#FFFFFF',
  secondaryColor: '#000000',
  accentColor: '#FF0000',
  pattern: 'classic',
  finish: 'matte',
  logo: null,
};

// ----------------------------------------------------------------------------
// Default design title
// ----------------------------------------------------------------------------

/**
 * Documented default human-readable title for a freshly-reset (ST-020)
 * or never-saved design.
 *
 * Usage:
 *   - The New Design dialog (ST-020) seeds its title field with this
 *     value when the user confirms a reset.
 *   - The Save Design dialog (ST-018) MAY use this as a placeholder when
 *     no prior title is in scope; the {@link createDesign} call sends
 *     the user's input verbatim and falls back to this constant when
 *     the input is empty.
 *   - The Design Summary Sidebar (ST-022) displays this title in the
 *     summary header until the user enters a real title.
 *
 * The value is intentionally a non-empty English string (rather than an
 * empty string) so that:
 *   - the summary sidebar always has something to render in its title
 *     field (ST-022-AC1's "human-readable form"),
 *   - the backend's create-design validation (ST-027-AC1's required
 *     title field) accepts this constant as-is on a New-Design-then-Save
 *     flow with no further input,
 *   - the value is unambiguously "default-untitled" rather than
 *     accidentally-blank, which prevents users from concluding that
 *     their title was lost.
 *
 * Type:
 *   The constant is typed as the inferred `string` (no `as const`
 *   narrowing) because callers commonly hold it in a mutable string
 *   field (e.g., `useState<string>(DEFAULT_DESIGN_TITLE)`) that the
 *   user can subsequently overwrite. Narrowing to a literal type would
 *   force callers to cast the assignment back to `string` at every
 *   write site.
 *
 * Localization:
 *   Localization is out of scope for the 49-story product surface;
 *   this hardcoded English string is the documented behavior. A future
 *   localization milestone would replace this constant with a key
 *   resolved through an i18n library, at which point every consumer
 *   site below would migrate together.
 */
export const DEFAULT_DESIGN_TITLE: string = 'Untitled Design';
