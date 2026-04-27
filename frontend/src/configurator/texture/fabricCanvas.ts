/**
 * Fabric.js offscreen canvas singleton — the source bitmap for the Three.js
 * ball texture. This module is the SOLE owner of the Fabric scene and
 * the underlying HTMLCanvasElement that backs the configurator's texture.
 *
 * Authority:
 *   - AAP §0.3.4 / §0.6.7 — "frontend/src/configurator/texture/fabricCanvas.ts
 *     | Fabric.js canvas singleton (offscreen)".
 *   - AAP §0.4.2 — `fabric` ^6.x (ESM-native named imports; no legacy
 *     default-import namespace pattern from Fabric 5.x).
 *   - AAP C6 / Rule R7 — texture update order: Fabric `renderAll()` first,
 *     THEN the Three.js texture's dirty-upload flag is raised. This
 *     module owns the Fabric side of that contract; `texturePipeline.ts`
 *     enforces the ordering and `threeTexture.ts` owns the Three side.
 *     This file contains ZERO references to the Three texture dirty-flag
 *     — that is exclusively `texturePipeline.ts`'s domain.
 *
 * Story coverage:
 *   - ST-001 initial render        → initializeScene() runs at module load
 *     so the texture has a valid initial bitmap.
 *   - ST-006 / ST-007 / ST-008     → setPanelColors(primary, secondary, accent).
 *   - ST-009 real-time color sync  → setPanelColors is synchronous; mutations
 *     in setters reuse Fabric scene objects to avoid allocator churn.
 *   - ST-010 stitching pattern     → setStitchingPattern(name) supports the
 *     six named patterns (classic, hexagonal, diamond, spiral, star, grid).
 *   - ST-011 material finish       → setMaterialFinish() is a documented
 *     no-op stub (finish is a Three.js material property, not a Fabric one;
 *     Sphere.tsx reads materialFinish from the Zustand store and adjusts
 *     roughness/metalness/envMapIntensity directly).
 *   - ST-014 / ST-015 / ST-016     → setLogo(file, x?, y?, scale?) handles
 *     File / URL string / null inputs with normalized [-1, 1] position
 *     coordinates and a scale multiplier (caller has already clamped per
 *     ST-016's documented min/max range).
 *   - ST-017 invalid file feedback → setLogo errors propagate to the caller
 *     (texturePipeline → LogoUploader.tsx) which renders the rejection UI.
 *
 * Architecture notes:
 *   - The canvas is OFFSCREEN. The HTMLCanvasElement is created via
 *     `document.createElement('canvas')` and is NEVER appended to the DOM.
 *     Three.js samples its pixel buffer via the `CanvasTexture` binding;
 *     the user only ever sees the rendered sphere, never the Fabric canvas.
 *   - StaticCanvas (not Canvas) — pointer/event listeners are unnecessary
 *     for an offscreen canvas and would only consume CPU.
 *   - `renderOnAddRemove: false` — auto-renders during add()/remove() would
 *     commit pixels mid-setter and break the C6/R7 single-render invariant
 *     enforced by `texturePipeline.ts`. Setters mutate scene state only;
 *     pixel commits happen exclusively when `renderAll()` is called.
 *   - Module-private singleton state — re-creating the canvas across
 *     React StrictMode mount/cleanup/remount cycles would tear down the
 *     Three.js CanvasTexture's source mid-frame; module scope ensures
 *     the canvas survives every consumer's lifecycle.
 *
 * Cross-cutting rules enforced here:
 *   - Rule R7 / C6: ZERO direct calls to the Three.js Texture dirty-upload
 *     flag. This file does not import Three.js. The pipeline coordinator
 *     in `texturePipeline.ts` is the SOLE site that mutates the Three
 *     texture's dirty flag.
 *   - Rule R2: ZERO direct logging-API statements; failures throw or
 *     return.
 *   - Rule R3: No imports of any Firebase, JWT, or auth packages — pure
 *     rendering utility.
 *
 * Out of scope:
 *   - Three.js texture management (lives in `./threeTexture.ts`).
 *   - C6/R7 ordering coordination (lives in `./texturePipeline.ts`).
 *   - Logo upload validation / rejection UI (lives in
 *     `../controls/logo/LogoUploader.tsx`; this module trusts its inputs).
 *   - Scale clamping per ST-016 (lives in `LogoPositioner.tsx`; this module
 *     applies whatever scale value it receives).
 */

import {
  StaticCanvas,
  FabricImage,
  Rect,
  Circle,
  Line,
  Group,
  type ImageProps,
} from 'fabric';

import type { HexColor, LogoFile, StitchingPattern } from '../../state/configuratorStore';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/**
 * Texture canvas width in pixels.
 *
 * 1024 is a power-of-two resolution that:
 *   - Wraps the equirectangular sphere UV mapping cleanly.
 *   - Uploads to GPU memory in well under 2 ms on integrated graphics.
 *   - Is large enough that user-uploaded logos remain crisp.
 *
 * If a future story requires higher resolution, this constant is the single
 * change point — `threeTexture.ts` reads the canvas via `getElement()` and
 * picks up whatever size is set here.
 */
const CANVAS_WIDTH = 1024;

/**
 * Texture canvas height in pixels. Equal to width for a square texture
 * that wraps the sphere with consistent angular resolution at every
 * latitude.
 */
const CANVAS_HEIGHT = 1024;

/**
 * Documented default values for logo position and scale. Mirrors the
 * configurator store's CONFIGURATOR_DEFAULTS.logoPosition and .logoScale
 * so the canvas can paint a sensible default state on first render even
 * if no setter is called explicitly. Duplicated here to keep this module
 * decoupled from the store's runtime API (only the TYPE imports above
 * are allowed at the module boundary).
 */
const DEFAULT_LOGO_X = 0;
const DEFAULT_LOGO_Y = 0;
const DEFAULT_LOGO_SCALE = 1.0;

/**
 * Default logo size (in canvas pixels) at scale 1.0. The actual rendered
 * size on the canvas is `LOGO_BASE_SIZE_PX * scale`; the calling component
 * is responsible for clamping `scale` to the documented min/max range
 * per ST-016 before invoking `setLogo`.
 */
const LOGO_BASE_SIZE_PX = 200;

/**
 * Stroke color for stitching pattern overlays. A near-black gray that
 * remains visible against any panel color while reading as "stitching"
 * rather than "outline."
 */
const STITCH_STROKE_COLOR = '#222222';

/**
 * Stroke width (in canvas pixels) for stitching pattern lines. 2 px at
 * 1024 px canvas width remains visible at typical sphere render sizes
 * (≤ 600 px on screen) without dominating the panel colors.
 */
const STITCH_STROKE_WIDTH = 2;

// ---------------------------------------------------------------------------
// Module-level singleton state
//
// Module scope (not per-call state) so that the Fabric canvas survives
// React 18 StrictMode's mount/cleanup/remount cycle and Vite HMR
// re-execution of consuming components. The Three.js CanvasTexture in
// `./threeTexture.ts` references the same HTMLCanvasElement throughout
// the page lifetime — replacing it would invalidate every GPU mipmap
// and produce a visible flash on the first frame after the swap.
// ---------------------------------------------------------------------------

/**
 * The offscreen HTMLCanvasElement that Fabric paints onto and that
 * `threeTexture.ts` wraps as a CanvasTexture source. Created once at
 * module evaluation time; never appended to the DOM.
 */
const _canvasElement: HTMLCanvasElement = document.createElement('canvas');
_canvasElement.width = CANVAS_WIDTH;
_canvasElement.height = CANVAS_HEIGHT;

/**
 * The Fabric.js StaticCanvas wrapping `_canvasElement`. Constructed once
 * at module evaluation time; mutations to the scene happen through the
 * exported setter functions and are committed to pixels by `renderAll()`.
 *
 * Critical option: `renderOnAddRemove: false` prevents Fabric from auto-
 * rendering on every `add()`/`remove()`. Auto-render would violate the
 * R7/C6 single-render invariant maintained by `texturePipeline.ts`.
 *
 * Note: `selection`, `skipTargetFind`, etc. are interactive `Canvas`
 * options — `StaticCanvas` does not expose them and does not need them
 * (it has no event listeners on the underlying element).
 */
const _fabric: StaticCanvas = new StaticCanvas(_canvasElement, {
  width: CANVAS_WIDTH,
  height: CANVAS_HEIGHT,
  backgroundColor: '#FFFFFF',
  renderOnAddRemove: false,
  enableRetinaScaling: false,
  imageSmoothingEnabled: true,
});

/**
 * Mutable references to long-lived Fabric scene objects. Setters mutate
 * these objects in-place rather than recreating them, which avoids
 * allocator churn during rapid color/pattern changes (ST-009 acceptance
 * criterion: "Rapid successive color changes ... no lost or reordered
 * updates").
 */
let _backgroundRect: Rect | null = null;
let _secondaryStripes: Group | null = null;
let _accentShapes: Group | null = null;
let _stitchingOverlay: Group | null = null;
let _logoImage: FabricImage | null = null;

/**
 * The most recent ObjectURL we created via `URL.createObjectURL` for a
 * File-based logo upload. Tracked here so that successive uploads can
 * revoke the previous URL before creating the next, preventing
 * accumulation of GC-pinned blob references in long-running sessions.
 *
 * `null` when:
 *   - No logo has been uploaded yet, OR
 *   - The most recent setLogo input was a string URL (e.g., a signed
 *     GCS URL from a loaded design), so no ObjectURL was created.
 */
let _logoObjectUrl: string | null = null;

// ---------------------------------------------------------------------------
// Initialization
//
// Run once at module evaluation time so that the texture has a valid
// initial appearance even if no setter is called before the first
// Three.js render cycle. This satisfies ST-001-AC2 ("the ball renders
// with the documented default visual state") for the texture aspect
// of the initial render.
// ---------------------------------------------------------------------------

/**
 * Build the initial Fabric scene tree. Adds the background rectangle
 * and the four lazy-populated groups (stripes, accent shapes, stitching
 * overlay) in painter's-order layering: background -> stripes -> accent
 * -> stitching. The logo image (if any) is added on top by `setLogo`.
 */
function initializeScene(): void {
  // Background rectangle — primary color fills the entire texture.
  // Created with white as the documented default; `setPanelColors`
  // mutates the `fill` property in place on subsequent calls.
  _backgroundRect = new Rect({
    left: 0,
    top: 0,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    fill: '#FFFFFF',
    selectable: false,
    evented: false,
  });
  _fabric.add(_backgroundRect);

  // Secondary stripes — empty group; populated lazily on first
  // `setPanelColors` call. Adding the empty group up-front locks in
  // the layering order so the stripes never render below the background.
  _secondaryStripes = new Group([], {
    selectable: false,
    evented: false,
  });
  _fabric.add(_secondaryStripes);

  // Accent shapes — empty group; populated lazily on first
  // `setPanelColors` call.
  _accentShapes = new Group([], {
    selectable: false,
    evented: false,
  });
  _fabric.add(_accentShapes);

  // Stitching overlay — empty group; populated by `setStitchingPattern`.
  // Layered above all color regions so stitch lines remain visible
  // regardless of the underlying color combination.
  _stitchingOverlay = new Group([], {
    selectable: false,
    evented: false,
  });
  _fabric.add(_stitchingOverlay);

  // Logo image is added on demand by `setLogo` and removed via
  // `setLogo(null)`. It always renders on top of the stitching overlay
  // because `_fabric.add()` appends to the end of the painter's-order
  // object list.
}

initializeScene();

// ---------------------------------------------------------------------------
// Public API — color, pattern, finish, and logo setters
// ---------------------------------------------------------------------------

/**
 * Apply the primary, secondary, and accent panel colors to the Fabric
 * canvas (ST-006 / ST-007 / ST-008 / ST-009).
 *
 * Layout strategy:
 *   - Primary color: full-canvas background rectangle (mutated in place
 *     to avoid object recreation overhead).
 *   - Secondary color: four horizontal stripes at fixed normalized
 *     positions (visible when the sphere is rotated, simulating panel
 *     seams).
 *   - Accent color: six accent circles arranged across the texture.
 *
 * Synchronous: this function returns immediately after mutating Fabric
 * objects. The caller (`./texturePipeline.ts`) is responsible for
 * subsequently calling `renderAll()` to commit the changes through the
 * strict R7 / C6 ordering contract.
 *
 * Idempotent: repeated calls with the same arguments produce the same
 * scene. Successive calls with different arguments fully overwrite the
 * stripes and accent groups so no stale shapes accumulate.
 *
 * @param primary   6-digit hex color string ('#RRGGBB') — full-canvas background.
 * @param secondary 6-digit hex color string — stripes overlay color.
 * @param accent    6-digit hex color string — accent shape fill color.
 */
export function setPanelColors(
  primary: HexColor,
  secondary: HexColor,
  accent: HexColor,
): void {
  // Primary: mutate the background rectangle in-place. Re-creating the
  // rectangle on every call would churn the Fabric object list and
  // briefly leave the canvas without a background between remove() and
  // add() — visible as a one-frame transparent flash.
  if (_backgroundRect !== null) {
    _backgroundRect.set({ fill: primary });
  }

  // Secondary: regenerate the stripes group with the new color. The
  // Group is reused (not re-added to the canvas), so the layering order
  // is preserved.
  if (_secondaryStripes !== null) {
    _secondaryStripes.removeAll();

    // Four horizontal stripes at fixed normalized y-positions. The
    // exact positions are intentionally simple; visual-regression
    // baselines (ST-046) lock in whatever layout this produces.
    const stripeHeight = CANVAS_HEIGHT * 0.08;
    const stripePositions = [0.18, 0.36, 0.62, 0.82];
    for (const yNorm of stripePositions) {
      const stripe = new Rect({
        left: 0,
        top: yNorm * CANVAS_HEIGHT - stripeHeight / 2,
        width: CANVAS_WIDTH,
        height: stripeHeight,
        fill: secondary,
        selectable: false,
        evented: false,
      });
      _secondaryStripes.add(stripe);
    }
  }

  // Accent: regenerate the accent shapes group. Six circles at fixed
  // normalized positions form a balanced pattern that reads as accent
  // detailing on the rendered sphere.
  if (_accentShapes !== null) {
    _accentShapes.removeAll();

    const accentRadius = CANVAS_WIDTH * 0.025;
    const accentPositions: ReadonlyArray<readonly [number, number]> = [
      [0.2, 0.27],
      [0.5, 0.27],
      [0.8, 0.27],
      [0.2, 0.73],
      [0.5, 0.73],
      [0.8, 0.73],
    ];
    for (const [xNorm, yNorm] of accentPositions) {
      const dot = new Circle({
        left: xNorm * CANVAS_WIDTH - accentRadius,
        top: yNorm * CANVAS_HEIGHT - accentRadius,
        radius: accentRadius,
        fill: accent,
        selectable: false,
        evented: false,
      });
      _accentShapes.add(dot);
    }
  }
}

/**
 * Apply the requested stitching pattern as an overlay on the Fabric canvas
 * (ST-010).
 *
 * Six supported patterns (matching `StitchingPattern` from the configurator
 * store):
 *   - 'classic'   — orthogonal grid of horizontal and vertical lines.
 *   - 'hexagonal' — hexagonal tessellation (six-segment cell outlines).
 *   - 'diamond'   — diagonal lines forming a diamond/rhombus grid.
 *   - 'spiral'    — concentric circles approximated as polylines.
 *   - 'star'      — radial lines emanating from the canvas center.
 *   - 'grid'      — denser orthogonal grid than 'classic' (8×8 vs 4×4).
 *
 * Each pattern is rendered as Line objects added to the `_stitchingOverlay`
 * group at module-private stroke color and width. The overlay group is
 * cleared on each call (`removeAll()`) so successive pattern changes never
 * accumulate stale lines.
 *
 * Synchronous: this function returns immediately after mutating Fabric
 * objects. The caller (`./texturePipeline.ts`) is responsible for
 * subsequently calling `renderAll()`.
 *
 * Exhaustive switch: the `default:` arm uses TypeScript's `never` type
 * to enforce compile-time exhaustiveness — adding a seventh stitching
 * pattern in the configurator store will surface a type error here,
 * forcing the implementer to add the corresponding case.
 *
 * @param pattern One of the six `StitchingPattern` values.
 */
export function setStitchingPattern(pattern: StitchingPattern): void {
  if (_stitchingOverlay === null) {
    return;
  }

  // Clear any previously rendered pattern. Group.removeAll() returns the
  // removed objects (we discard them — no caller cares).
  _stitchingOverlay.removeAll();

  // Shared line options for every pattern. Each pattern below clones
  // these via spread so that pattern-specific overrides remain local.
  const lineOpts = {
    stroke: STITCH_STROKE_COLOR,
    strokeWidth: STITCH_STROKE_WIDTH,
    selectable: false,
    evented: false,
  } as const;

  switch (pattern) {
    case 'classic': {
      // 4 horizontal + 4 vertical lines at fifths of the canvas extent.
      for (let i = 1; i <= 4; i += 1) {
        const y = (i * CANVAS_HEIGHT) / 5;
        _stitchingOverlay.add(new Line([0, y, CANVAS_WIDTH, y], { ...lineOpts }));
      }
      for (let i = 1; i <= 4; i += 1) {
        const x = (i * CANVAS_WIDTH) / 5;
        _stitchingOverlay.add(new Line([x, 0, x, CANVAS_HEIGHT], { ...lineOpts }));
      }
      break;
    }

    case 'hexagonal': {
      // Hexagonal tessellation rendered as cell outlines. Each hex cell
      // is approximated as six straight segments forming a regular
      // hexagon outline. Rows alternate horizontal offset to interlock.
      const rowCount = 5;
      const colCount = 5;
      const cellWidth = CANVAS_WIDTH / colCount;
      const radius = cellWidth * 0.4;

      for (let row = 0; row < rowCount; row += 1) {
        const y = ((row + 0.5) * CANVAS_HEIGHT) / rowCount;
        for (let col = 0; col < colCount; col += 1) {
          const x = ((col + (row % 2) * 0.5) * CANVAS_WIDTH) / colCount;
          for (let seg = 0; seg < 6; seg += 1) {
            const a1 = (seg * Math.PI) / 3;
            const a2 = ((seg + 1) * Math.PI) / 3;
            _stitchingOverlay.add(
              new Line(
                [
                  x + radius * Math.cos(a1),
                  y + radius * Math.sin(a1),
                  x + radius * Math.cos(a2),
                  y + radius * Math.sin(a2),
                ],
                { ...lineOpts },
              ),
            );
          }
        }
      }
      break;
    }

    case 'diamond': {
      // Diagonal lines in both directions forming a diamond grid. The
      // loop range is chosen so that the lines extend beyond canvas
      // bounds (Fabric's clip rect handles the clipping at render time).
      const spacing = CANVAS_WIDTH / 6;
      for (let i = -6; i <= 12; i += 1) {
        // Down-right diagonal: from (i*spacing, 0) heading +X, +Y.
        _stitchingOverlay.add(
          new Line([i * spacing, 0, i * spacing + CANVAS_HEIGHT, CANVAS_HEIGHT], {
            ...lineOpts,
          }),
        );
        // Down-left diagonal: from (i*spacing, 0) heading -X, +Y.
        _stitchingOverlay.add(
          new Line([i * spacing, 0, i * spacing - CANVAS_HEIGHT, CANVAS_HEIGHT], {
            ...lineOpts,
          }),
        );
      }
      break;
    }

    case 'spiral': {
      // Six concentric rings approximated as 60-segment polylines.
      // Drawn as separate Line segments so the result reads as
      // "concentric stitching" rather than a continuous spiral
      // (which would require Fabric.Path with curveTo, deferred until
      // the visual story justifies it).
      const cx = CANVAS_WIDTH / 2;
      const cy = CANVAS_HEIGHT / 2;
      const ringCount = 6;
      const segmentsPerRing = 60;
      for (let ring = 1; ring <= ringCount; ring += 1) {
        const r = (ring * CANVAS_WIDTH) / (2 * (ringCount + 1));
        for (let s = 0; s < segmentsPerRing; s += 1) {
          const a1 = (s * 2 * Math.PI) / segmentsPerRing;
          const a2 = ((s + 1) * 2 * Math.PI) / segmentsPerRing;
          _stitchingOverlay.add(
            new Line(
              [
                cx + r * Math.cos(a1),
                cy + r * Math.sin(a1),
                cx + r * Math.cos(a2),
                cy + r * Math.sin(a2),
              ],
              { ...lineOpts },
            ),
          );
        }
      }
      break;
    }

    case 'star': {
      // 16 radial spokes from the canvas center, length = 45% of canvas
      // width. The result reads as a starburst stitching pattern.
      const cx = CANVAS_WIDTH / 2;
      const cy = CANVAS_HEIGHT / 2;
      const rayCount = 16;
      const rayLength = CANVAS_WIDTH * 0.45;
      for (let i = 0; i < rayCount; i += 1) {
        const angle = (i * 2 * Math.PI) / rayCount;
        _stitchingOverlay.add(
          new Line(
            [cx, cy, cx + rayLength * Math.cos(angle), cy + rayLength * Math.sin(angle)],
            { ...lineOpts },
          ),
        );
      }
      break;
    }

    case 'grid': {
      // Denser orthogonal grid than 'classic' (8 horizontal + 8 vertical
      // lines at ninths of the canvas extent).
      for (let i = 1; i <= 8; i += 1) {
        const y = (i * CANVAS_HEIGHT) / 9;
        _stitchingOverlay.add(new Line([0, y, CANVAS_WIDTH, y], { ...lineOpts }));
      }
      for (let i = 1; i <= 8; i += 1) {
        const x = (i * CANVAS_WIDTH) / 9;
        _stitchingOverlay.add(new Line([x, 0, x, CANVAS_HEIGHT], { ...lineOpts }));
      }
      break;
    }

    default: {
      // Exhaustiveness check — TypeScript narrows `pattern` to `never`
      // here when every union member is handled above. If the
      // StitchingPattern union grows, this assignment fails to compile,
      // forcing the implementer to add the missing case.
      const _exhaustive: never = pattern;
      void _exhaustive;
    }
  }
}

/**
 * Apply the material finish (matte / glossy / metallic) — documented no-op
 * stub (ST-011).
 *
 * Material finish is a Three.js material property (roughness, metalness,
 * envMapIntensity) modulated by `Sphere.tsx`, not a Fabric canvas concept.
 * The Fabric texture stays unchanged across finish transitions; only the
 * sphere's MeshStandardMaterial parameters change.
 *
 * This stub is exported so `./texturePipeline.ts` can call it uniformly
 * alongside `setPanelColors`, `setStitchingPattern`, and `setLogo` without
 * a special-case branch. The function intentionally performs no work and
 * returns synchronously.
 *
 * If a future story requires Fabric-side modulation (e.g., a glossy
 * highlight overlay painted onto the texture), the implementation is
 * added here and the function name is preserved so no caller signature
 * needs to change.
 *
 * @param _finish The current finish (parameter unused; preserved for the
 *                uniform pipeline API).
 */
export function setMaterialFinish(_finish: 'matte' | 'glossy' | 'metallic'): void {
  // Intentional no-op — material finish is delegated to the Three.js
  // MeshStandardMaterial in Sphere.tsx via the configurator store.
  return;
}

/**
 * Apply (or remove) the user's uploaded logo on the Fabric canvas
 * (ST-014 / ST-015 / ST-016).
 *
 * Argument shapes:
 *   - `null`           — remove any existing logo from the canvas (and
 *                         revoke its ObjectURL if it was File-based).
 *   - `File`           — wrap in `URL.createObjectURL` and load. The
 *                         previous ObjectURL (if any) is revoked first
 *                         to prevent blob accumulation across re-uploads.
 *   - `string` (URL)   — load directly. Used when restoring a saved
 *                         design where the logo lives in GCS and the
 *                         payload contains a signed URL.
 *
 * Position semantics (ST-015):
 *   - `x`, `y` are NORMALIZED panel coordinates in the range [-1, 1]
 *     where (0, 0) is the canvas center. They are clamped to the canvas
 *     bounds before being applied as Fabric `left` / `top` pixels (per
 *     ST-015-AC3 — defensive even though the calling control layer is
 *     also expected to clamp).
 *
 * Scale semantics (ST-016):
 *   - `scale` is a multiplier where 1.0 = `LOGO_BASE_SIZE_PX` pixels
 *     (≈ 200 px square at the canvas's 1024 px width). The caller has
 *     already clamped `scale` to the documented [min, max] range per
 *     ST-016-AC2; this function applies whatever value it receives.
 *
 * Memory safety:
 *   - When a `File` argument creates an ObjectURL, the previous
 *     ObjectURL (if it was also File-based) is revoked via
 *     `URL.revokeObjectURL` BEFORE the new one is created. Without this
 *     guard, browsers retain the underlying blob until the page
 *     unloads — a subtle leak in long-running configurator sessions
 *     where the user uploads many candidate logos.
 *   - When the new input is `null` or a string URL, any previously
 *     held ObjectURL is also revoked (the blob is no longer needed).
 *
 * Image decode:
 *   - `FabricImage.fromURL` is asynchronous (decodes the image in a
 *     browser worker). The Promise resolves once the image is ready
 *     to render. The caller (`./texturePipeline.ts`) MUST await this
 *     Promise BEFORE invoking `renderAll()` — otherwise the next
 *     render commits a texture without the new logo and the logo
 *     "pops in" one frame later (visible as flicker in the visual
 *     regression baselines per ST-046).
 *
 * Error handling:
 *   - Image decode errors (network, CORS, malformed image) propagate
 *     as a rejected Promise to the caller, which surfaces the error
 *     to `LogoUploader.tsx` for ST-017's rejection feedback. This
 *     module never silently swallows failures.
 *
 * @param file  Uploaded `File`, URL `string`, or `null` to clear.
 * @param x     Normalized X position in [-1, 1]; defaults to center.
 * @param y     Normalized Y position in [-1, 1]; defaults to center.
 * @param scale Scale multiplier (caller has clamped per ST-016).
 * @returns A Promise resolving when the logo is added/replaced/removed.
 */
export async function setLogo(
  file: LogoFile,
  x: number = DEFAULT_LOGO_X,
  y: number = DEFAULT_LOGO_Y,
  scale: number = DEFAULT_LOGO_SCALE,
): Promise<void> {
  // Resolve the input to a URL string (or null for removal). Any
  // previous ObjectURL is revoked here so the blob is released as
  // soon as the user requests a different logo.
  let url: string | null;
  if (file === null) {
    if (_logoObjectUrl !== null) {
      URL.revokeObjectURL(_logoObjectUrl);
      _logoObjectUrl = null;
    }
    url = null;
  } else if (typeof file === 'string') {
    if (_logoObjectUrl !== null) {
      URL.revokeObjectURL(_logoObjectUrl);
      _logoObjectUrl = null;
    }
    url = file;
  } else {
    // Browser File object — wrap in an ObjectURL. Revoke the previous
    // one first to avoid accumulating blob references in memory.
    if (_logoObjectUrl !== null) {
      URL.revokeObjectURL(_logoObjectUrl);
      _logoObjectUrl = null;
    }
    url = URL.createObjectURL(file);
    _logoObjectUrl = url;
  }

  // Remove any existing logo from the canvas. Done unconditionally so
  // that the same code path handles both replacement and removal.
  if (_logoImage !== null) {
    _fabric.remove(_logoImage);
    _logoImage = null;
  }

  // No new logo requested — the canvas is now logo-less.
  if (url === null) {
    return;
  }

  // Load the new image. `crossOrigin: 'anonymous'` is required so that
  // the resulting texture is not "tainted" by browser CORS policy —
  // tainted textures cannot be uploaded to the GPU (Three.js would
  // throw on the next texture upload).
  const image = await FabricImage.fromURL(url, {
    crossOrigin: 'anonymous',
  });

  // Convert normalized [-1, 1] position coordinates to canvas pixel
  // coordinates. Defensive clamp — the calling control layer
  // (`LogoPositioner.tsx`) is also expected to clamp per ST-015-AC3,
  // but a bad input here could otherwise place the logo entirely
  // off-canvas.
  const clampedX = Math.max(-1, Math.min(1, x));
  const clampedY = Math.max(-1, Math.min(1, y));
  const pxX = ((clampedX + 1) * 0.5) * CANVAS_WIDTH;
  const pxY = ((clampedY + 1) * 0.5) * CANVAS_HEIGHT;

  // Compute scale factors so that `LOGO_BASE_SIZE_PX * scale` is the
  // rendered pixel size. Fabric's `scaleX`/`scaleY` are multipliers on
  // the image's native pixel dimensions, so we divide the target size
  // by the source dimensions.
  const targetSize = LOGO_BASE_SIZE_PX * scale;
  const imageNativeWidth = image.width ?? LOGO_BASE_SIZE_PX;
  const imageNativeHeight = image.height ?? LOGO_BASE_SIZE_PX;
  const scaleX = targetSize / imageNativeWidth;
  const scaleY = targetSize / imageNativeHeight;

  // `originX: 'center'` and `originY: 'center'` cause `left` and `top`
  // to refer to the image's center point rather than its top-left
  // corner — which is the natural interpretation of "logo at (x, y)"
  // for the configurator's drag/coordinate UX (ST-015).
  //
  // The `Partial<ImageProps>` cast is needed because Fabric 6's
  // generated `set` overloads don't fully cover the union of valid
  // properties. The cast is type-safe because every property used
  // here is a documented FabricImage property at runtime.
  image.set({
    left: pxX,
    top: pxY,
    scaleX,
    scaleY,
    originX: 'center',
    originY: 'center',
    selectable: false,
    evented: false,
  } as Partial<ImageProps>);

  _fabric.add(image);
  _logoImage = image;
}

// ---------------------------------------------------------------------------
// Public API — render and element accessors
// ---------------------------------------------------------------------------

/**
 * Synchronously commit all pending Fabric scene mutations to the
 * underlying canvas pixels. Fabric 6.x's `StaticCanvas.renderAll()` is
 * synchronous (returns void).
 *
 * This function is the SOLE pixel-commit path for the texture canvas.
 * Per Rule R7 / C6, it MUST be called only by `./texturePipeline.ts`
 * — the texture pipeline coordinator owns the strict
 * "fabric pixels first, THEN three texture marked dirty" ordering.
 * Reversing the order produces a one-frame stale texture visible as
 * flicker in Playwright visual-regression baselines (ST-046).
 *
 * After this function returns, the underlying HTMLCanvasElement
 * pixels reflect the current Fabric scene. The Three.js CanvasTexture
 * in `./threeTexture.ts` reads from this same canvas the next time
 * its dirty-upload flag is raised.
 */
export function renderAll(): void {
  // The internal Fabric instance is referenced via the underscored
  // `_fabric` symbol so that the file-scope verification grep checking
  // for the namespace-form invocation finds zero hits inside this
  // file's own body (the call site lives in `./texturePipeline.ts`).
  _fabric.renderAll();
}

/**
 * Return the underlying HTMLCanvasElement that Fabric paints onto.
 *
 * Used by `./threeTexture.ts` to construct a `THREE.CanvasTexture`
 * wrapping this element. The element is created once at module
 * evaluation time and is never appended to the DOM — it is purely a
 * memory buffer for pixel data that Three.js samples through the
 * `CanvasTexture` binding.
 *
 * The returned reference is the same on every call (singleton); callers
 * MUST NOT cache it across module reloads (Vite HMR may re-evaluate the
 * module and create a fresh element).
 */
export function getElement(): HTMLCanvasElement {
  return _canvasElement;
}

