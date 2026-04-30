# syntax=docker/dockerfile:1.6
# =====================================================================
# StrikeForge Frontend — Multi-stage Dockerfile
# =====================================================================
# Stage 1 (builder)    — Node 20 LTS + dev/runtime deps + Vite build
# Stage 2 (production) — nginx 1.27 + compiled static dist on port 8080
#
# Authority:
#   * AAP §0.3.4 — "frontend/Dockerfile | Multi-stage build: builder
#     (Vite build) → production (nginx + static dist)".
#   * AAP §0.4.4 — base images pinned to `node:20-alpine` (builder)
#     and `nginx:1.27-alpine` (production); AAP §0.1.1 pins Node.js
#     20 LTS, AAP §0.4.4 pins nginx 1.27-alpine for the frontend
#     production stage serving the Vite `dist/` output.
#   * AAP §0.6.2 Phase A — "Multi-stage Vite build → nginx static
#     serving".
#   * AAP §0.6.7 Track 2 — the frontend bundles React 18 + Vite 5 +
#     @react-three/fiber 8 + @react-three/drei 9 + three 0.160.x +
#     fabric 6 + firebase 10 + zustand 4. The `npm run build` script
#     in `frontend/package.json` runs `tsc --noEmit && vite build`
#     to produce the optimized static dist consumed by stage 2.
#   * Rule R4 — the production image sets ZERO defaults for any
#     environment variable. The browser bundle reads only build-time
#     `import.meta.env.*` values (Vite-injected) which are baked in
#     at build time; no runtime env vars are required by nginx.
#   * Rule R8 — gates fail closed: every RUN step exits non-zero on
#     install/build failure; the lockfile detection branch makes the
#     install step explicitly deterministic instead of silently
#     falling back across error categories.
#   * Cloud Run convention — port 8080 is the default $PORT for
#     Cloud Run; the nginx server block listens on 8080 so the image
#     is ready for Cloud Run / Knative / GKE deployment without
#     port translation.
#
# Build context constraints (documented per the user-provided
# Explainability Rule):
#   * The frontend Dockerfile is built with `frontend/` as the build
#     context (matching the backend pattern: `cloudbuild.yaml` and
#     `skaffold.yaml` use a per-package context, not the monorepo
#     root). Inside `frontend/`:
#       1. `frontend/package.json` IS visible.
#       2. `frontend/package-lock.json` is NOT typically present —
#          the npm-workspaces lockfile lives at `/package-lock.json`
#          in the monorepo root, outside this build context.
#       3. The fallback to `npm install` is therefore the expected
#          install path during ordinary builds; `npm ci` is used
#          when a frontend-local lockfile has been generated (e.g.,
#          for hermetic CI builds).
#     Reproducibility in the workspace context is preserved by the
#     explicit version pins in `frontend/package.json` plus the
#     immutable COMMIT_SHA-tagged image emitted by Cloud Build when
#     this Dockerfile is added to the build pipeline.
#   * The frontend service is intentionally NOT included in
#     `docker-compose.yml` (per AAP scaffolding requirements: the
#     frontend runs locally via `cd frontend && npm run dev` on the
#     Vite dev server :5173). This Dockerfile exists for production
#     deployments and any future CI/CD frontend build step.
#
# SPA serving model:
#   * The Vite production build emits a single-page application —
#     all client-side routes are handled by `frontend/src/App.tsx`
#     and resolved within the browser. The nginx config below
#     therefore implements an SPA fallback: any request that does
#     NOT match an actual file under `/usr/share/nginx/html` is
#     rewritten to `/index.html`, allowing deep links to client
#     routes (e.g., `/configurator/<id>`) to bootstrap the SPA
#     instead of returning 404.
#   * Vite-hashed asset filenames (e.g., `/assets/index-abc123.js`)
#     are served with `Cache-Control: public, immutable` because
#     any change to an asset produces a different hash and a
#     different filename — clients never need to re-fetch a stale
#     cached entry.
#   * `index.html` itself is served `no-cache, no-store,
#     must-revalidate` so deployments propagate immediately and
#     the SPA always loads against the freshest set of hashed
#     asset references.
#
# =====================================================================
# Stage 1 — builder
# =====================================================================
FROM node:20-alpine AS builder

# Working directory inside the build container. All COPY/RUN steps
# below operate within `/app`, mirroring the layout the Vite build
# expects (package.json, src/, vite.config.ts, etc., all colocated).
WORKDIR /app

# -----------------------------------------------------------------
# Layer 1: dependencies — cache-friendly install step.
#
# Copy ONLY the package manifest (and lockfile if present) before
# the rest of the source. This produces a Docker layer that is
# reused across rebuilds whenever neither file has changed,
# dramatically speeding up incremental builds.
#
# The `package-lock.json*` glob safely matches zero or one file:
#   * Zero matches when this Dockerfile is built with `frontend/`
#     as the context and the workspace lockfile lives at the repo
#     root (the typical npm-workspaces case for this monorepo).
#   * One match when a hermetic, frontend-local lockfile has been
#     generated alongside `frontend/package.json` (e.g., during
#     a release-pipeline lockfile-publish step).
# -----------------------------------------------------------------
COPY package.json package-lock.json* ./

# -----------------------------------------------------------------
# Install dependencies. Two install paths exist; the conditional
# selects the correct one based on the presence of a lockfile in
# the build context. This explicit branching (rather than a silent
# `npm ci || npm install` fallback) keeps Rule R8 compliance:
# real `npm ci` failures (e.g., a corrupt or out-of-date lockfile)
# propagate as build failures instead of being masked by the
# fallback running `npm install` and silently mutating the install
# tree.
#
# Behaviour:
#   * If `package-lock.json` is present, run `npm ci` for a strict,
#     reproducible install bound exactly to the lockfile contents.
#   * Otherwise (the workspaces case where the lockfile lives at
#     the repository root and is not part of this build context),
#     fall back to `npm install`. Reproducibility in this branch
#     is preserved by the explicit version pins in
#     `frontend/package.json` plus the immutable COMMIT_SHA-tagged
#     image produced by Cloud Build.
#
# Both branches use `--no-audit --no-fund` to suppress non-essential
# network calls and console noise that slow CI runs without
# affecting installation correctness. Either branch fails the build
# on non-zero exit (Rule R8).
# -----------------------------------------------------------------
RUN if [ -f package-lock.json ]; then \
        echo "builder: lockfile present — running 'npm ci'"; \
        npm ci --no-audit --no-fund; \
    else \
        echo "builder: no lockfile in build context — running 'npm install'"; \
        npm install --no-audit --no-fund; \
    fi

# -----------------------------------------------------------------
# `frontend/tsconfig.json` extends `../tsconfig.json` (the monorepo
# root config). The Docker build context is `frontend/`, so the
# parent tsconfig is NOT in the build context. Synthesize a minimal
# placeholder at the expected path (`/tsconfig.json`, since WORKDIR
# is `/app` and `..` resolves to `/`) so the `extends` clause
# resolves at compile time. The placeholder declares no compiler
# options; `frontend/tsconfig.json` itself fully specifies `strict`,
# target, module, jsx, and every other option, so the synthesized
# file is a no-op from a configuration standpoint while satisfying
# TypeScript's file resolution requirements. This mirrors the same
# pattern used by `backend/Dockerfile`.
# -----------------------------------------------------------------
RUN echo '{"compilerOptions":{},"exclude":[]}' > /tsconfig.json

# -----------------------------------------------------------------
# Layer 2: source + build.
#
# Copy the rest of the frontend source and run the Vite build. The
# `npm run build` script in `frontend/package.json` runs
# `tsc --noEmit && vite build`:
#   1. `tsc --noEmit` performs a strict TypeScript type-check
#      (Rule: no `any` leakage, all React/TSX type-safety preserved)
#      without emitting JS — Vite handles emit through esbuild/SWC.
#   2. `vite build` produces a hashed, tree-shaken, minified static
#      bundle in `/app/dist/` consisting of `index.html` plus
#      `assets/*` (JS chunks, CSS, images, fonts).
#
# A failure in either step (type-check or bundle) returns a
# non-zero exit and fails the Docker build (Rule R8).
# -----------------------------------------------------------------
COPY . .
RUN npm run build


# =====================================================================
# Stage 2 — production (nginx serving the static dist)
# =====================================================================
FROM nginx:1.27-alpine AS production

# -----------------------------------------------------------------
# Replace the default nginx server block with an SPA-aware
# configuration. The configuration is inlined via a heredoc to
# avoid a separate file dependency; this matches the AAP's
# "inline the nginx config" guidance and keeps the entire serving
# contract visible in this single Dockerfile.
#
# Server block summary:
#   * Listens on 8080 (IPv4 + IPv6) — Cloud Run / Knative
#     convention; nginx default :80 is intentionally NOT used.
#   * `gzip on` with the standard MIME-type allow-list reduces
#     wire bytes for HTML/CSS/JS/SVG/JSON without burdening
#     pre-compressed binary assets (PNG, WOFF2, etc.).
#   * `/assets/*` files are served `public, immutable` with a
#     1-year expiry, safe because Vite hashes the filenames.
#   * `/healthz` returns `ok` with HTTP 200 — Cloud Run platform
#     and any orchestrator probe can mark the service healthy
#     without going through the cache-busted index.html.
#   * `/` (exact match) and `/...` (catch-all SPA fallback) both
#     emit `no-cache, no-store, must-revalidate` so a fresh deploy
#     is visible to every client on the next page load.
#   * `try_files $uri $uri/ /index.html` is the SPA fallback —
#     any request that does not map to an actual file or directory
#     returns `index.html`, enabling client-side routing for
#     deep links such as `/configurator/<design-id>`.
# -----------------------------------------------------------------
RUN cat > /etc/nginx/conf.d/default.conf <<'EOF'
server {
    listen 8080;
    listen [::]:8080;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    # Compression for text-class responses. Binary assets (PNG,
    # WOFF2, etc.) are already compressed and are NOT re-gzipped.
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_min_length 1024;
    gzip_types
        text/plain
        text/css
        text/xml
        text/javascript
        application/javascript
        application/json
        application/xml
        application/xml+rss
        image/svg+xml;

    # Hashed asset files (Vite places them under /assets/ with a
    # content hash in the filename). Safe to cache forever.
    location ~* ^/assets/.*\.(?:js|mjs|css|png|jpg|jpeg|gif|svg|webp|avif|woff|woff2|ttf|otf|ico|map)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
        try_files $uri =404;
    }

    # Health endpoint for Cloud Run / Knative platform probes.
    # Returns plaintext "ok" with HTTP 200 and is excluded from
    # access logs to keep telemetry signal-to-noise high.
    location = /healthz {
        access_log off;
        add_header Content-Type text/plain;
        add_header Cache-Control "no-store";
        return 200 "ok";
    }

    # Index HTML at root: never cache — keeps fresh deployments
    # visible to clients on the next request without forcing a
    # refresh of long-lived hashed asset bundles.
    location = / {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files /index.html =404;
    }

    # SPA fallback: any path that does NOT map to a real file or
    # directory returns index.html so the client-side router can
    # resolve deep links (e.g., /configurator/<id>, /share/<token>).
    location / {
        add_header Cache-Control "no-cache, no-store, must-revalidate";
        try_files $uri $uri/ /index.html;
    }

    # Disable serving of dotfiles (e.g., .env, .git) by accident.
    location ~ /\. {
        deny all;
        return 404;
    }
}
EOF

# -----------------------------------------------------------------
# Remove the default nginx welcome page BEFORE copying the Vite
# dist. If we copied first and removed afterward, the default
# index.html could shadow the Vite-built one in race conditions
# (e.g., if Vite ever omitted index.html from the build output);
# clearing the directory first guarantees /usr/share/nginx/html
# starts empty and contains only the application's own artifacts.
# -----------------------------------------------------------------
RUN rm -f /usr/share/nginx/html/index.html /usr/share/nginx/html/50x.html

# -----------------------------------------------------------------
# Copy the built static assets from the builder stage into the
# nginx web root. The alpine nginx image runs the master process
# as root and spawns workers as `nginx`; the static files only
# need to be world-readable, which they are by default since
# node:20-alpine's umask produces 0644 file modes during the
# builder stage's `vite build`.
# -----------------------------------------------------------------
COPY --from=builder /app/dist /usr/share/nginx/html

# -----------------------------------------------------------------
# Cloud Run / Knative expects the container to listen on the port
# announced via $PORT (default 8080). The nginx server block above
# is bound to 8080 explicitly. EXPOSE is documentation only — it
# does NOT publish the port; the runtime (Cloud Run, docker run
# -p, etc.) is responsible for actually exposing it.
# -----------------------------------------------------------------
EXPOSE 8080

# -----------------------------------------------------------------
# Health check: the platform layer (Cloud Run) probes /healthz on
# its own schedule, but a Docker-level HEALTHCHECK enables the
# image to self-report status when run under docker, docker-compose,
# or any orchestrator that honours the directive. The wget invocation
# is from busybox-compatible binaries shipped in nginx:alpine; the
# probe times out at 5s and runs every 30s after a 5s start grace.
# -----------------------------------------------------------------
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

# -----------------------------------------------------------------
# Run nginx in the foreground so the container's PID 1 is the
# nginx master process. `daemon off;` is the canonical nginx
# pattern for containers and ensures signals (SIGTERM from Cloud
# Run / Kubernetes) reach nginx for graceful shutdown.
# -----------------------------------------------------------------
CMD ["nginx", "-g", "daemon off;"]
