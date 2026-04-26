/**
 * `design-builder.ts` — Deterministic design payload factory.
 *
 * Integration tests use this factory to obtain stable, reproducible design
 * payloads for `POST /api/designs` (ST-027). The core guarantee is that
 * calling `buildDesignPayload(seed)` with the same `seed` returns the same
 * payload across Node versions, CI runs, and machines — a prerequisite
 * for ST-044-AC2 ("same source tree → same verdict").
 *
 * ============================================================================
 * Authority and Mapping
 * ============================================================================
 *   - ST-044-AC2 (verbatim): "Each run uses deterministic fixtures (seeded
 *     data, stubbed external dependencies) so repeated runs against the same
 *     source tree produce the same verdict ...". This factory IS the seeded
 *     fixture for design payloads.
 *   - ST-030-AC1: the `designs` table's columns include "title, full design
 *     payload (colors, pattern, finish, logo reference and placement)".
 *     The exported types match this exact shape so payloads written by this
 *     factory survive a round-trip through Postgres JSONB unchanged.
 *   - ST-027-AC1: "configurator selections (colors, stitching pattern,
 *     material finish, logo reference and placement)". Every selection has
 *     a value in the produced payload.
 *   - AAP §0.2.1 (configurator semantics): three colors (EP-002 / ST-006..
 *     ST-009), stitching pattern (ST-010, six values), material finish
 *     (ST-011, three values), logo reference + placement (ST-014..ST-017).
 *   - Folder requirement (`backend/tests/integration/fixtures/`):
 *     "design-builder.ts — Deterministic design payload factory
 *     (ST-044-AC2 compliance)".
 *
 * ============================================================================
 * Determinism Guarantee
 * ============================================================================
 *   - Calling `buildDesignPayload(seed)` with the same `seed` MUST return
 *     a deep-equal payload across Node versions and CI runs.
 *   - The seeded PRNG is xmur3 (string → 32-bit integer stream) followed
 *     by sfc32 (Simple Fast Counter, public-domain). This combination is
 *     a well-known, pure-JS deterministic PRNG that does NOT depend on any
 *     V8 internals or Math.random seeding (which JavaScript does not
 *     support — the spec leaves Math.random's seed implementation-defined).
 *   - Floating-point placement coordinates are rounded to 3 decimals via
 *     `round3` so JSON serialization produces stable bit sequences across
 *     platforms (e.g., 0.1 + 0.2 = 0.30000000000000004 becomes 0.3).
 *
 * ============================================================================
 * Why an Inline PRNG (No `seedrandom` Dependency)
 * ============================================================================
 *   - The `seedrandom` npm package is NOT in `backend/package.json`.
 *   - Adding a dependency is out of scope for this agent (per AAP §0.4.1
 *     dependency inventory pinning).
 *   - The inline xmur3 + sfc32 pattern is ~30 lines, has no upstream
 *     vulnerabilities to track, and produces identical output across all
 *     Node 20+ runtime patches and architectures.
 *
 * ============================================================================
 * Rule Compliance
 * ============================================================================
 *   - Rule R1 (story ACs authoritative): ST-044-AC2 determinism is the
 *     primary specification driving this file's design.
 *   - Rule R2 (no credential material in logs): the returned payload
 *     contains NO password, NO token, NO bearer string, NO API key, NO
 *     secret. The `reference` string is a logo filename (e.g.,
 *     `test-canonical-logo.png`) — a benign object key.
 *   - Rule R3 (Firebase Admin SDK only): N/A — no auth surface touched.
 *   - Rule R4 (no env defaults in source): no env vars are read.
 *   - Rule R6 / C4 (OTel registration order): no OTel imports.
 *   - Rule R8 (gates fail closed): non-string seeds throw a TypeError
 *     immediately — there is NO silent fallback.
 *   - Rule R9 (no payment processing): N/A — no payment surface touched.
 *   - LocalGCP Verification Rule: N/A — pure in-memory factory; no GCS
 *     interaction. Logo `reference` strings are filenames a CALLER may
 *     upload via `gcs-bucket.ts` if their test exercises real signed-URL
 *     retrieval, but that decision lives in the caller, not here.
 *
 * ============================================================================
 * Usage
 * ============================================================================
 *   ```ts
 *   import { buildDesignPayload } from './fixtures/design-builder';
 *
 *   // Snapshot-stable canonical payload (default seed).
 *   const canonical = buildDesignPayload();
 *   // -> { title: 'Canonical Design',
 *   //      payload: { primaryColor: '#FF0000', secondaryColor: '#00FF00',
 *   //                 accentColor: '#0000FF', pattern: 'classic',
 *   //                 finish: 'matte',
 *   //                 logo: { reference: 'test-canonical-logo.png',
 *   //                         placement: { x: 0.5, y: 0.5,
 *   //                                      scale: 1.0, rotation: 0 } } } }
 *
 *   // Reproducible variant — same seed always yields the same payload.
 *   const variantA = buildDesignPayload('user-123-design-1');
 *   const variantAgain = buildDesignPayload('user-123-design-1');
 *   // JSON.stringify(variantA) === JSON.stringify(variantAgain)
 *   ```
 */

// No external imports. This file is a pure, dependency-free factory.

// ---------------------------------------------------------------------------
// Exported Types
// ---------------------------------------------------------------------------

/**
 * Placement metadata for an optional logo overlay on the design.
 * All values are normalized to sensible ranges:
 *   - `x`, `y`: normalized [0.0, 1.0] UV coordinates on the sphere surface.
 *   - `scale`: logo size multiplier in [0.5, 1.5] (1.0 = native size).
 *   - `rotation`: degrees in [0, 360).
 */
export interface DesignLogoPlacement {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

/**
 * Optional logo block embedded in the design payload.
 * `reference` is a GCS object key (not a full URL); the backend resolves it
 * against `GCS_BUCKET_NAME` at read time.
 */
export interface DesignLogo {
  reference: string;
  placement: DesignLogoPlacement;
}

/**
 * JSON shape of the `payload` JSONB column in the `designs` table (ST-030).
 * The three colors are 7-character hex strings (`#RRGGBB`, uppercase).
 * `pattern` is one of the six stitching patterns (ST-010); `finish` is one
 * of the three material finishes (ST-011).
 */
export interface DesignPayloadBody {
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  pattern: string;
  finish: string;
  logo?: DesignLogo;
}

/**
 * Top-level request body for `POST /api/designs` (ST-027).
 * Matches the `designs` table schema: `title` TEXT + `payload` JSONB.
 */
export interface DesignPayload {
  title: string;
  payload: DesignPayloadBody;
}

// ---------------------------------------------------------------------------
// Enumerated Value Lists
// ---------------------------------------------------------------------------

/**
 * Six color choices for variant payloads. Each is a 7-character `#RRGGBB`
 * hex string, uppercase, and JSON-safe. The set is deliberately small so
 * `pickDistinct` can always find three mutually-distinct colors without
 * exhausting the candidate list.
 */
const COLOR_CHOICES: readonly string[] = [
  '#FF0000',
  '#00FF00',
  '#0000FF',
  '#FFFF00',
  '#FF00FF',
  '#00FFFF',
];

/**
 * Six stitching patterns per ST-010. Names match the frontend control
 * vocabulary in
 * `frontend/src/configurator/controls/pattern/StitchingPatternSelector.tsx`.
 */
const PATTERN_CHOICES: readonly string[] = [
  'classic',
  'modern',
  'retro',
  'sport',
  'minimal',
  'bold',
];

/**
 * Three material finishes per ST-011. Names match the frontend control
 * vocabulary in `frontend/src/configurator/controls/pattern/FinishSelector.tsx`.
 */
const FINISH_CHOICES: readonly string[] = ['matte', 'glossy', 'metallic'];

// ---------------------------------------------------------------------------
// Seeded PRNG (xmur3 + sfc32)
// ---------------------------------------------------------------------------

/**
 * String-hashing function (xmur3). Converts a string seed into a reproducible
 * 32-bit integer stream that can initialize sfc32's four seed integers.
 *
 * Reference: Andrew Kensler / public-domain implementation (PractRand).
 * This implementation is pure JS and produces identical outputs across Node
 * versions and browsers.
 *
 * @param seed - the string to hash.
 * @returns a function that yields successive 32-bit unsigned integers
 *   derived from the seed; each call returns a fresh integer.
 */
function xmur3(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return (): number => {
    h = Math.imul(h ^ (h >>> 16), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
}

/**
 * Simple Fast Counter PRNG (sfc32). Given 4 seed integers, produces a stream
 * of floats in [0, 1). Reproducible across Node versions and architectures.
 *
 * Reference: Chris Doty-Humphrey / public-domain implementation (PractRand).
 *
 * @param a - first seed integer.
 * @param b - second seed integer.
 * @param c - third seed integer.
 * @param d - fourth seed integer.
 * @returns a function that, on each call, returns the next deterministic
 *   float in [0, 1).
 */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return (): number => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Build a deterministic PRNG from a string seed. Each call with the same
 * seed produces the SAME sequence of floats — critical for ST-044-AC2.
 *
 * NOTE: This helper is NOT exported. It is an implementation detail of
 * `buildDesignPayload`; locking it behind the factory API lets future
 * maintainers swap PRNG algorithms (e.g., sfc32 → mulberry32) without
 * breaking any caller.
 *
 * @param seed - the string seed.
 * @returns a function returning successive deterministic floats in [0, 1).
 */
function createSeededRng(seed: string): () => number {
  const hashStream = xmur3(seed);
  return sfc32(hashStream(), hashStream(), hashStream(), hashStream());
}

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

/**
 * Pick an element from `choices` using the given seeded RNG.
 * Always returns a well-defined element (never `undefined`) because every
 * call site in this module supplies a non-empty `choices` array.
 *
 * Defensive clamp: in the unlikely event that `rng()` returns exactly 1.0
 * (which sfc32 does NOT, but better safe than sorry), the index is
 * clamped to `choices.length - 1`.
 *
 * @param rng - seeded RNG function returning floats in [0, 1).
 * @param choices - non-empty readonly array of candidate values.
 * @returns one element of `choices`, deterministically chosen.
 */
function pickFrom<T>(rng: () => number, choices: readonly T[]): T {
  const index = Math.floor(rng() * choices.length);
  const safe = Math.min(index, choices.length - 1);
  return choices[safe] as T;
}

/**
 * Pick an element of `choices` that is NOT in `already`. If filtering
 * exhausts the candidate set (which cannot happen for the enumerated
 * value lists in this module — they are all longer than the largest
 * `already` set), falls back to picking from the unfiltered set so the
 * function always returns a value.
 *
 * @param rng - seeded RNG function.
 * @param choices - readonly array of candidate values.
 * @param already - readonly array of already-picked values to exclude.
 * @returns an element of `choices` not present in `already` (when possible).
 */
function pickDistinct<T>(rng: () => number, choices: readonly T[], already: readonly T[]): T {
  const filtered = choices.filter((candidate) => !already.includes(candidate));
  if (filtered.length === 0) {
    return pickFrom(rng, choices);
  }
  return pickFrom(rng, filtered);
}

/**
 * Round to 3 decimal places so tests that serialize the payload to JSON
 * don't produce different bit representations across platforms. For
 * example `0.1 + 0.2` is `0.30000000000000004` natively, but
 * `round3(0.1 + 0.2)` is exactly `0.3`.
 *
 * @param value - the value to round.
 * @returns the value rounded to 3 decimal places.
 */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Clamp a value to [min, max] inclusive.
 *
 * @param value - the value to clamp.
 * @param min - minimum allowed value.
 * @param max - maximum allowed value.
 * @returns the value clamped to [min, max].
 */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

// ---------------------------------------------------------------------------
// Canonical Payload Constants
// ---------------------------------------------------------------------------

/**
 * Canonical payload shape constants. Stored as primitives (rather than as a
 * frozen object) so each call to `buildDesignPayload('canonical')` builds a
 * fresh object literal — there is no shared object that a caller could
 * mutate to poison subsequent calls.
 */
const CANONICAL_TITLE = 'Canonical Design';
const CANONICAL_PRIMARY = '#FF0000';
const CANONICAL_SECONDARY = '#00FF00';
const CANONICAL_ACCENT = '#0000FF';
const CANONICAL_PATTERN = 'classic';
const CANONICAL_FINISH = 'matte';
const CANONICAL_LOGO_REFERENCE = 'test-canonical-logo.png';
const CANONICAL_PLACEMENT_X = 0.5;
const CANONICAL_PLACEMENT_Y = 0.5;
const CANONICAL_PLACEMENT_SCALE = 1.0;
const CANONICAL_PLACEMENT_ROTATION = 0;

/**
 * The literal seed string that triggers the canonical payload branch.
 * Calling `buildDesignPayload()` (no args) and `buildDesignPayload('canonical')`
 * are equivalent and both return the canonical payload.
 */
const CANONICAL_SEED = 'canonical';

// ---------------------------------------------------------------------------
// Exported Factory
// ---------------------------------------------------------------------------

/**
 * Build a deterministic design payload suitable for `POST /api/designs`
 * (ST-027). The same seed MUST produce the same payload across Node
 * versions and CI runs (ST-044-AC2).
 *
 * Default seed: `'canonical'`. When called without arguments OR with the
 * string literal `'canonical'`, returns a fixed payload with known colors,
 * pattern, finish, and logo — suitable for snapshot assertions.
 *
 * For any OTHER seed, returns a payload whose fields are chosen from the
 * enumerated value lists (`COLOR_CHOICES`, `PATTERN_CHOICES`,
 * `FINISH_CHOICES`) by a seeded PRNG. The secondary and accent colors are
 * guaranteed distinct from the primary color (and from each other). The
 * logo placement is randomized but clamped to:
 *   - `x`, `y`:    [0, 1]
 *   - `scale`:     [0.5, 1.5]
 *   - `rotation`:  [0, 360)  (integer degrees)
 *
 * The returned object is a fresh allocation; mutating it does NOT affect
 * any subsequent call to this function.
 *
 * @param seed - optional seed string; default `'canonical'`.
 * @returns a fresh (non-shared) `DesignPayload` object.
 * @throws TypeError if `seed` is provided but is not a string. This is
 *   intentional fail-closed behavior (Rule R8): a misuse like
 *   `buildDesignPayload(42 as any)` should surface immediately rather than
 *   silently coercing the number to `'42'` and producing a "successful"
 *   but surprising result.
 */
export function buildDesignPayload(seed: string = CANONICAL_SEED): DesignPayload {
  // Defensive type check: TypeScript's compile-time guarantees do not extend
  // to JavaScript callers (e.g., a JS test file using `require()`). Throwing
  // here makes invalid usage loud rather than silently coercing.
  if (typeof seed !== 'string') {
    throw new TypeError(`buildDesignPayload: seed must be a string, got ${typeof seed}`);
  }

  if (seed === CANONICAL_SEED) {
    // Build a fresh object literal each call so callers can mutate freely
    // without poisoning subsequent calls. The constants above are
    // primitive (string/number) so there is no shared reference.
    return {
      title: CANONICAL_TITLE,
      payload: {
        primaryColor: CANONICAL_PRIMARY,
        secondaryColor: CANONICAL_SECONDARY,
        accentColor: CANONICAL_ACCENT,
        pattern: CANONICAL_PATTERN,
        finish: CANONICAL_FINISH,
        logo: {
          reference: CANONICAL_LOGO_REFERENCE,
          placement: {
            x: CANONICAL_PLACEMENT_X,
            y: CANONICAL_PLACEMENT_Y,
            scale: CANONICAL_PLACEMENT_SCALE,
            rotation: CANONICAL_PLACEMENT_ROTATION,
          },
        },
      },
    };
  }

  // Variant branch: derive every field from the seeded PRNG so the same
  // seed → same payload, every time.
  const rng = createSeededRng(seed);

  const primaryColor = pickFrom(rng, COLOR_CHOICES);
  const secondaryColor = pickDistinct(rng, COLOR_CHOICES, [primaryColor]);
  const accentColor = pickDistinct(rng, COLOR_CHOICES, [primaryColor, secondaryColor]);
  const pattern = pickFrom(rng, PATTERN_CHOICES);
  const finish = pickFrom(rng, FINISH_CHOICES);

  const placement: DesignLogoPlacement = {
    x: round3(clamp(rng(), 0, 1)),
    y: round3(clamp(rng(), 0, 1)),
    scale: round3(clamp(0.5 + rng() * 1.0, 0.5, 1.5)),
    rotation: Math.floor(rng() * 360),
  };

  return {
    title: `Variant Design (${seed})`,
    payload: {
      primaryColor,
      secondaryColor,
      accentColor,
      pattern,
      finish,
      logo: {
        reference: `test-${seed}-logo.png`,
        placement,
      },
    },
  };
}
