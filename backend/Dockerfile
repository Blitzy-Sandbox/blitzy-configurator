# syntax=docker/dockerfile:1.6
# StrikeForge Backend — Multi-stage Dockerfile
# Stage 1 (builder): Node 20 LTS + full devDependencies + TS compile
# Stage 2 (production): Node 20 LTS + pruned prod deps + compiled dist + non-root user
# This image is built as gcr.io/$PROJECT_ID/strikeforge:$COMMIT_SHA in cloudbuild.yaml step 'build'.

#####################################
# Stage 1: builder
#####################################
FROM node:20-alpine AS builder

# Install build tools required by native npm modules (pg, OTel native deps)
RUN apk add --no-cache \
    bash \
    python3 \
    make \
    g++ \
    libc6-compat

WORKDIR /app

# Copy package manifests first for better layer caching
COPY package.json package-lock.json* ./

# Install ALL dependencies (devDependencies included for TypeScript compilation)
RUN npm install --no-audit --no-fund

# Copy the rest of the source
COPY tsconfig.json ./
COPY src ./src
COPY migrations ./migrations

# Compile TypeScript (no-op until src/ exists; safe placeholder)
RUN npm run build

# Prune devDependencies so the production stage can copy a lean node_modules
RUN npm prune --omit=dev


#####################################
# Stage 2: production
#####################################
FROM node:20-alpine AS production

ENV NODE_ENV=production
ENV PORT=3000

# dumb-init for proper SIGTERM forwarding (Cloud Run graceful shutdown)
RUN apk add --no-cache dumb-init

# Create a dedicated non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -u 1001 -S -G nodejs nodejs

WORKDIR /app

COPY --from=builder --chown=nodejs:nodejs /app/node_modules ./node_modules
COPY --from=builder --chown=nodejs:nodejs /app/dist ./dist
COPY --from=builder --chown=nodejs:nodejs /app/migrations ./migrations
COPY --from=builder --chown=nodejs:nodejs /app/package.json ./package.json

USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD wget -qO- http://127.0.0.1:${PORT}/healthz || exit 1

ENTRYPOINT ["dumb-init", "--"]

CMD ["node", "dist/index.js"]
