# syntax=docker/dockerfile:1.6
# =====================================================================
# StrikeForge Backend — Multi-stage Dockerfile
# =====================================================================
# Stage 1 (builder)    — Node 20 LTS + dev/runtime deps + TypeScript build
# Stage 2 (production) — Node 20 LTS + pruned runtime deps + compiled dist
#
# Authority:
#   * AAP §0.3.3 — "backend/Dockerfile | Multi-stage build: builder
#     (full devDeps + compile) → production (pruned node_modules + dist)"
#   * AAP §0.4.4 — base image pinned to `node:20-alpine`; AAP §0.1.1
#     pins Node.js 20 LTS as the backend runtime.
#   * AAP §0.6.2 Phase A — "Multi-stage builder → production on
#     node:20-alpine".
#   * AAP §0.6.11 MG2-G — produced via:
#       docker build --file backend/Dockerfile \
#                    --tag gcr.io/$PROJECT_ID/strikeforge:$COMMIT_SHA \
#                    backend/
#   * Rule R4 — the production image sets ZERO defaults for the six
#     required env vars (DATABASE_URL, FIREBASE_PROJECT_ID,
#     GCS_BUCKET_NAME, GCS_EMULATOR_HOST, COVERAGE_THRESHOLD,
#     GCP_REGION). Cloud Run / docker-compose injects them at runtime;
#     absence triggers fail-fast in `backend/src/config/env.ts` within
#     2 seconds (per AAP §0.2.2 R4 verification).
#   * Rule R6 / C4 — `backend/src/index.ts` imports `./tracing` first,
#     so OpenTelemetry auto-instrumentation registers before any
#     application module loads. This Dockerfile starts the compiled
#     `dist/index.js`; the import order is enforced in source.
#   * Rule R8 — gates fail closed: every RUN step exits non-zero on
#     install/compile failure; no `|| true`, no soft fallbacks that
#     would hide errors from Cloud Build.
#   * ST-040-AC4 — produces an immutable, content-addressable container
#     image; Cloud Build tags the result with `:$COMMIT_SHA` and
#     captures the registry-assigned digest as the deployment artifact.
#
# Build context constraints (documented per the user-provided
# Explainability Rule):
#   * Cloud Build invokes `docker build ... backend/`, so the build
#     context is the `backend/` directory only — the monorepo root
#     `package-lock.json` and root `tsconfig.json` are NOT visible
#     inside this build. Two workarounds are applied:
#       1. The npm-workspaces `package-lock.json` lives at the
#          repository root and is therefore absent from this build
#          context. We use `npm ci` when a lockfile IS present (the
#          reproducible-build path preferred by AAP §0.6.13), and fall
#          back to `npm install` when it is NOT (the workspaces path).
#          The fallback preserves reproducibility through the explicit
#          version pins in `backend/package.json` and the immutable
#          COMMIT_SHA-tagged image (ST-040-AC4).
#       2. `backend/tsconfig.json` extends `../tsconfig.json`. Since
#          the parent file is not in the build context, we synthesize
#          a minimal placeholder at `/tsconfig.json` so the `extends`
#          resolves; backend's own tsconfig fully declares `strict:
#          true` and every other compiler option, so the synthesized
#          file is a no-op from a configuration standpoint.
# =====================================================================


# ---------------------------------------------------------------------
# Stage 1 — builder
# ---------------------------------------------------------------------
# This stage is also the local-dev target via `docker-compose.yml`
# (`target: builder`), where `ts-node-dev` runs the TypeScript sources
# directly from a bind-mounted `./backend` directory. The compiled
# `dist/` output is produced here for the production stage's COPY.
# ---------------------------------------------------------------------
FROM node:20-alpine AS builder

# Native build tools required by some npm packages with native bindings:
#   * pg              — optional `pg-native` bindings
#   * firebase-admin  — transitive native modules (gRPC, protobuf)
#   * @opentelemetry  — optional native instrumentation hooks
# Alpine ships musl libc; `libc6-compat` provides glibc shims required
# by some prebuilt native binaries. `bash` covers npm postinstall
# scripts that hard-code `#!/bin/bash`. `python3 + make + g++` provide
# the toolchain for `node-gyp` to compile native bindings on first use.
RUN apk add --no-cache \
        bash \
        g++ \
        libc6-compat \
        make \
        python3

WORKDIR /app

# Copy package manifests FIRST so the dependency layer is cached when
# only application source changes. The wildcard `package-lock.json*`
# matches zero or one files (Docker COPY succeeds with zero matches),
# allowing the same Dockerfile to work when invoked from contexts that
# do (workspace root) or do not (npm-workspaces backend subfolder)
# include the lockfile.
COPY package.json package-lock.json* ./

# Install all dependencies (production + dev) so we can compile
# TypeScript. Strategy:
#   * If `package-lock.json` is present, use `npm ci` for a strict,
#     reproducible install per AAP §0.6.13 / ST-040-AC2.
#   * Otherwise (the npm-workspaces case where the lockfile lives at
#     the repository root), fall back to `npm install`. Reproducibility
#     in this branch is preserved by the explicit version pins in
#     `backend/package.json` plus the immutable COMMIT_SHA-tagged
#     image emitted by Cloud Build (ST-040-AC4 — same input commit
#     produces a content-addressable artifact identified by digest).
# Either branch fails the build on non-zero exit (Rule R8).
RUN if [ -f package-lock.json ]; then \
        echo "builder: lockfile present — running 'npm ci'"; \
        npm ci --no-audit --no-fund; \
    else \
        echo "builder: no lockfile in build context — running 'npm install'"; \
        npm install --no-audit --no-fund; \
    fi

# `backend/tsconfig.json` extends `../tsconfig.json` (the monorepo
# root config). The Docker build context is `backend/`, so the parent
# tsconfig is NOT in the build context. Synthesize a minimal empty
# placeholder at the expected path (`/tsconfig.json`, since WORKDIR is
# `/app` and `..` resolves to `/`) so the `extends` clause resolves at
# compile time. The placeholder declares no compiler options; the
# backend's own tsconfig fully specifies `strict: true`, target,
# module, and every other option, so the synthesized file is a no-op
# from a configuration standpoint while satisfying TypeScript's file
# resolution requirements.
RUN echo '{"compilerOptions":{},"exclude":[]}' > /tsconfig.json

# Copy the application source. `tsconfig.json` is copied separately
# from `src/` so future changes to it invalidate only the subsequent
# layers (preserving the dependency-install layer cache). The
# `migrations` directory is copied so node-pg-migrate can apply the
# schema (`npx node-pg-migrate up`) at runtime — both inside this
# image (production) and against the bind-mounted dev tree (builder).
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Compile TypeScript to `dist/`. The `npm run build` script in
# `backend/package.json` is `tsc`, which reads `./tsconfig.json` and
# writes to `./dist`. A non-zero exit fails the entire image build,
# satisfying Rule R8 (gates fail closed) and ST-040-AC3 (a build
# failure produces no image and prevents downstream deploy).
RUN npm run build

# Prune devDependencies so the production stage copies only what's
# needed to run the compiled server (no TypeScript compiler, no Jest,
# no linters, no test fixtures). Image-size impact: ~150 MB → ~80 MB.
RUN npm prune --omit=dev


# ---------------------------------------------------------------------
# Stage 2 — production
# ---------------------------------------------------------------------
# Cloud Run target. Receives the compiled `dist/`, pruned production
# `node_modules`, and migrations from the builder stage. Runs as a
# dedicated non-root user under `dumb-init` for proper signal handling.
# ---------------------------------------------------------------------
FROM node:20-alpine AS production

# Operational env vars (NOT among the six Rule R4 required vars).
# `NODE_ENV=production` is a marker downstream observability inspects.
# `PORT=3000` is a sensible default; Cloud Run overrides this via the
# platform's PORT env var contract, and docker-compose sets it via the
# service's `environment` block.
ENV NODE_ENV=production
ENV PORT=3000

# `dumb-init` is a tiny PID-1 init replacement (~1 MB) that:
#   * Forwards SIGTERM (and other signals) to the Node.js process. By
#     default, Node does not handle SIGTERM gracefully when running as
#     PID 1 — Cloud Run sends SIGTERM as its graceful-shutdown trigger
#     and then waits ~10 s before sending SIGKILL. Without dumb-init
#     the Node process is killed uncleanly on every deploy.
#   * Reaps orphaned zombie child processes spawned by Node.
RUN apk add --no-cache dumb-init

# Run as a non-root user. UID/GID 1001 is chosen to avoid collision
# with the default `node` user shipped in the official Node images
# (UID 1000). The `-S` flag creates a system user (no shell, no home
# directory besides /), which minimizes the attack surface.
RUN addgroup -g 1001 -S nodejs \
    && adduser -u 1001 -S -G nodejs nodejs

WORKDIR /app

# Copy only the artifacts needed to run the compiled server:
#   * node_modules — pruned to production deps (firebase-admin, pg,
#                    @google-cloud/storage, pino, OpenTelemetry, etc.)
#   * dist         — compiled JavaScript output; entry: dist/index.js
#   * migrations   — node-pg-migrate consumes these via
#                    `npx node-pg-migrate up` (run on app boot in
#                    development; run as a separate Cloud Run job step
#                    in production deployment).
#   * package.json — required so `node` resolves the `main` entry and
#                    so `npx node-pg-migrate` can read the
#                    `node-pg-migrate` config block at runtime.
# `--chown=nodejs:nodejs` ensures the runtime user owns every file,
# avoiding any read/write permission errors in the container.
COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

# Switch to the non-root user before EXPOSE/HEALTHCHECK/CMD so the
# server runs as `nodejs:1001` from the moment it starts.
USER nodejs

# Cloud Run reads the PORT env var directly; this `EXPOSE` is purely
# informational metadata for `docker inspect` and human readers. Local
# docker-compose maps host:3000 → container:3000.
EXPOSE 3000

# Liveness probe via `/healthz` (per ST-048). `wget` ships with the
# busybox `node:20-alpine` base image, so no additional install is
# needed. The healthcheck is fail-closed: a non-200 response from
# `/healthz` marks the container unhealthy. Cloud Run uses its own
# readiness probe (`/readyz`) and does not consume Docker HEALTHCHECK
# directives; this probe is exercised by docker-compose
# (`depends_on.condition: service_healthy`) and any other Docker-aware
# orchestrator.
#   * --start-period 30s — give Express time to start, run any boot
#     work, and become ready before failures count toward unhealthy.
#   * --interval 30s     — match the typical readiness probe cadence.
#   * --timeout 5s       — generous for an in-memory `/healthz` handler.
#   * --retries 3        — three consecutive failures = unhealthy.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" || exit 1

# `dumb-init --` is the canonical PID-1 init replacement. The trailing
# `--` is dumb-init's idiom for "everything after this is the command
# to exec", preventing dumb-init from interpreting any of the CMD
# arguments as its own flags.
ENTRYPOINT ["dumb-init", "--"]

# Start the compiled Express server. The compiled `dist/index.js`
# starts with `require('./tracing')` as its first side-effect import
# (Rule R6 / C4 — enforced in `backend/src/index.ts`), so OpenTelemetry
# auto-instrumentation registers before any application module is
# loaded.
CMD ["node", "dist/index.js"]
