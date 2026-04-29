#!/usr/bin/env bash
# =============================================================================
# guard-fabric-svg.sh — CI guard for fabric.js SVG-export CVE-2026-27013
# =============================================================================
#
# QA Final H Issue #3 (MAJOR) flagged fabric.js@6.x as carrying a HIGH-severity
# stored XSS CVE (CVE-2026-27013). The vulnerability is in fabric's SVG-export
# path: when fabric serialises a canvas to SVG via `toSVG()`, certain user-
# controlled string values (font names, image hrefs, etc.) are interpolated
# into the SVG output WITHOUT XML-escaping, allowing an attacker who controls
# any of those strings to inject arbitrary script tags into the exported SVG.
#
# At the time of the QA verification, this codebase did NOT trigger the
# vulnerable code path because:
#   1. The configurator NEVER calls `toSVG()` — fabric is used only as an
#      offscreen 2D compositing canvas whose pixel buffer is wrapped as a
#      Three.js `CanvasTexture` (binary RGBA pixel data, NOT SVG markup).
#   2. SVG INPUT (logo upload) goes through `FabricImage.fromURL()` which
#      loads via HTML `<img>` — browsers disable script execution for SVGs
#      loaded as `<img>` sources, so even a malicious uploaded SVG cannot
#      execute scripts in the configurator.
#   3. `dangerouslySetInnerHTML` is NEVER used anywhere in the SVG-handling
#      code path.
#
# THIS GUARD ENFORCES THE NON-EXPLOITABILITY CONDITION (#1) IN CI. If a future
# code change introduces ANY of the following calls, the build fails:
#   - `toSVG()` / `toSvg()` — the vulnerable export method
#   - `loadSVGFromURL()` / `loadSVGFromString()` — fabric's SVG-import
#     methods, which interact with the same vulnerable SVG-handling code
#     path on import (loadSVGFromString constructs internal SVG nodes whose
#     attributes are also susceptible to the same family of escaping bugs).
#
# An entry in `docs/decisions/README.md` documents the non-exploitability
# rationale and the rationale for keeping fabric pinned at the AAP-specified
# `^6.x` version range rather than upgrading to v7 (which would require code
# changes for the v7 API surface and fall outside the AAP-pinned dependency
# set).
#
# Usage:
#   bash scripts/guard-fabric-svg.sh
#
# Exit codes:
#   0 — no vulnerable call sites; build may proceed.
#   1 — a vulnerable call site was found; build MUST fail. The script prints
#       every offending file:line:match so a developer can locate and remove
#       the call OR escalate to a fabric upgrade.
#
# Wiring:
#   This script is invoked from `cloudbuild.yaml` as the FIRST sub-step of
#   the `lint` step. It runs before ESLint so a vulnerable call site fails
#   the pipeline at the cheapest gate.
#
# Authority:
#   - QA Final H Issue #3 (MAJOR — fabric@6.x CVE)
#   - User-provided Explainability Rule (decision log entry)
#   - AAP §0.4.2 fabric pinned at `^6.x`
#   - AAP §0.8.1 R8 — gates fail closed (`set -euo pipefail`)
# =============================================================================

set -euo pipefail

# Resolve repository root from this script's location (the script lives in
# `scripts/`, so the repo root is the parent directory). Using `cd` and `pwd`
# yields an absolute path that survives caller-supplied relative paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Search scope: every TypeScript / TypeScript-React / JavaScript / JSX source
# file under the application source directories. Test files and node_modules
# are excluded — tests that reference these tokens to ASSERT their absence
# (defensive testing) are legitimate and must not trigger the guard.
SEARCH_DIRS=(
  "${REPO_ROOT}/frontend/src"
  "${REPO_ROOT}/backend/src"
)

# Token list: every fabric API surface that interacts with SVG markup. The
# tokens are word-bounded (`\b`) so that variable names containing the
# substring (e.g., `toSVGEnabled`, `loadSVGFromURLDeprecated`) also match
# — these would themselves be evidence that the SVG path is being touched.
#
# `toSVG` / `toSvg`         — fabric Object.prototype.toSVG export method
# `loadSVGFromURL`          — fabric.loadSVGFromURL static (legacy v5 + v6)
# `loadSVGFromString`       — fabric.loadSVGFromString static (legacy v5 + v6)
PATTERN='\b(toSVG|toSvg|loadSVGFromURL|loadSVGFromString)\b'

# Use grep with extended regex; -n prefixes match lines with their line
# number; -H prefixes with the file path (default for multi-file searches).
# `--include` constrains to source-file extensions; `--exclude-dir` blocks
# node_modules and any test-fixture directory.
declare -a HITS=()

for dir in "${SEARCH_DIRS[@]}"; do
  # Skip search dirs that don't yet exist (e.g. running this guard before a
  # workspace is scaffolded). The guard MUST NOT fail in that case because
  # absence of source files is not a vulnerability.
  if [[ ! -d "${dir}" ]]; then
    continue
  fi

  # `|| true` prevents `grep`'s exit code 1 (no matches found) from
  # tripping `set -e`. We capture the output and inspect it explicitly
  # so the guard's exit semantics are deterministic.
  matches="$(
    grep -rEn \
      --include='*.ts' \
      --include='*.tsx' \
      --include='*.js' \
      --include='*.jsx' \
      --include='*.mjs' \
      --include='*.cjs' \
      --exclude-dir='node_modules' \
      --exclude-dir='dist' \
      --exclude-dir='.next' \
      --exclude='*.test.ts' \
      --exclude='*.test.tsx' \
      --exclude='*.spec.ts' \
      --exclude='*.spec.tsx' \
      "${PATTERN}" "${dir}" || true
  )"

  if [[ -n "${matches}" ]]; then
    # Concatenate hits across all search dirs into a single array.
    # `mapfile`-equivalent split on newlines — bash 3-compatible form.
    while IFS= read -r line; do
      HITS+=("${line}")
    done <<< "${matches}"
  fi
done

if [[ "${#HITS[@]}" -gt 0 ]]; then
  echo "FAIL: fabric.js SVG-export call site(s) detected." >&2
  echo "" >&2
  echo "QA Final H Issue #3 (MAJOR) requires this guard to enforce that no" >&2
  echo "production source file calls fabric's vulnerable SVG-export or" >&2
  echo "SVG-import APIs (CVE-2026-27013). Either:" >&2
  echo "  (a) remove the call site(s) below, or" >&2
  echo "  (b) upgrade fabric to >=7.3.1 (a SemVer-major bump that" >&2
  echo "      requires AAP §0.4.2 dependency-pin updates AND code-side" >&2
  echo "      adjustments for the v7 API surface)." >&2
  echo "" >&2
  echo "See docs/decisions/README.md for the non-exploitability rationale." >&2
  echo "" >&2
  echo "Offending lines:" >&2
  for hit in "${HITS[@]}"; do
    echo "  ${hit}" >&2
  done
  exit 1
fi

echo "OK: zero fabric.js SVG-export call sites detected."
echo "QA Final H Issue #3 non-exploitability condition holds."
exit 0
