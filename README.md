# blitzy-configurator

StrikeForge 3D sports ball configurator — a TypeScript monorepo housing the
React + R3F frontend, Express + PostgreSQL backend, and the Cloud
Build / Cloud Deploy delivery pipeline.

## Repository Layout

```
.
├── backend/               # Express 4.x + PostgreSQL + Firebase Admin + GCS API
├── frontend/              # React 18 + Vite + R3F + Fabric.js configurator
├── delivery-pipeline/     # Cloud Deploy pipeline + targets (dev → staging → prod)
├── docs/                  # Architecture decisions, observability, executive summary
├── tickets/               # 12 epics (EP-001..EP-012), 49 stories (ST-001..ST-049)
├── docker-compose.yml     # Local stack: PostgreSQL 15, Firebase Auth + GCS emulators, backend
├── cloudbuild.yaml        # 7-step CI pipeline: lint → typecheck → unit → integration → build → deploy → promotion
├── skaffold.yaml          # Skaffold config for Cloud Deploy renders
├── package.json           # npm workspaces root (backend, frontend)
├── tsconfig.json          # Shared strict TypeScript baseline
├── .eslintrc.json         # Shared ESLint configuration
├── .prettierrc            # Shared Prettier configuration
├── .nvmrc                 # Node 20 LTS pin
└── .env.example           # All six required environment variables (no defaults — see Rule R4)
```

## Prerequisites

| Tool          | Pinned Version              | How to install                                                                           |
| ------------- | --------------------------- | ---------------------------------------------------------------------------------------- |
| Node.js       | 20 LTS (`v20.x`)            | `nvm install` (uses `.nvmrc`)                                                            |
| npm           | 10.x (bundled with Node)    | bundled                                                                                  |
| Docker Engine | Current stable + Compose V2 | https://docs.docker.com/engine/install/                                                  |
| `gcloud` CLI  | Latest stable               | https://cloud.google.com/sdk/docs/install (only required for Cloud Build / Cloud Deploy) |

This repository pins every runtime version explicitly. Do not use Node versions
other than the one in `.nvmrc`; `engines` in `package.json` enforces this at
install time.

## Local Development Quick-Start

```bash
# 1. Use the pinned Node version
nvm use

# 2. Configure environment variables (see Rule R4 below)
cp .env.example .env
# Edit .env and supply real values for all six required variables.

# 3. Install workspace dependencies
npm install

# 4. Start the full local stack — Phase A Gate A.
#    This brings up all four services: postgres, firebase-auth-emulator,
#    gcs-emulator, and backend. The backend mounts the host's `backend/src/`
#    via a bind-mount and runs `ts-node-dev --respawn` for hot reload.
docker compose up -d

# 5. Verify all four services reached running state — Phase A Gate A.
#    Note: docker compose v2 emits NDJSON (one object per line), so use `.State`
#    on each line rather than `.[].State` (which would require a JSON array).
docker compose ps --format json | jq -r '.State' | sort | uniq
# Expected: running

# 6. Verify the backend liveness probe (Phase A Gate A health check).
curl -sf http://localhost:3000/healthz
# Expected: {"status":"ok"}

# 7. Apply database migrations (requires backend/migrations/ from Track 1).
#    Migrations run automatically inside the backend container at startup, so
#    on the host this is normally a no-op:
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/strikeforge \
  npm --workspace backend run migrate:up

# 8. To run the frontend dev server locally:
npm --workspace frontend run dev
```

## Required Environment Variables (Rule R4)

The application **fails fast at startup** when any of these six variables is
unset. There are no defaults in source code. See `.env.example` for documentation.

| Variable              | Consumer                                                                |
| --------------------- | ----------------------------------------------------------------------- |
| `DATABASE_URL`        | All PostgreSQL connections (TCP locally, Cloud SQL Unix socket in prod) |
| `FIREBASE_PROJECT_ID` | Firebase Admin SDK initialization                                       |
| `GCS_BUCKET_NAME`     | Logo upload + retrieval bucket via `@google-cloud/storage` v7           |
| `GCS_EMULATOR_HOST`   | Local / CI GCS emulator endpoint                                        |
| `COVERAGE_THRESHOLD`  | Unit test coverage gate (integer 0–100)                                 |
| `GCP_REGION`          | Cloud Deploy / Cloud Run region                                         |

## Common Scripts

```bash
# Static analysis & tests
npm run lint          # ESLint --max-warnings 0 in every workspace
npm run typecheck     # tsc --noEmit in every workspace
npm run test:unit     # Jest unit tests (backend)
npm run test:integration  # Jest integration tests (requires docker-compose services running)
npm run test:e2e      # Playwright Chromium + WebKit (frontend)
npm run test:visual   # Playwright visual regression (frontend)
npm run format        # Prettier --write across the repo

# Build
npm run build         # tsc (backend) + vite build (frontend)

# Database migrations
npm run migrate:up    # node-pg-migrate up
npm run migrate:down  # node-pg-migrate down
```

## CI / CD Overview

The pipeline is defined in `cloudbuild.yaml` and runs seven sequential steps
with explicit `waitFor` declarations:

1. **lint** — ESLint across both workspaces (`--max-warnings 0`)
2. **typecheck** — `tsc --noEmit` across both workspaces
3. **test:unit** — Jest unit tests with coverage gate (`COVERAGE_THRESHOLD`)
4. **test:integration** — Jest integration tests against dockerized dependencies
5. **build** — Multi-stage Docker image build, pushed to GCR
6. **deploy** — `gcloud deploy releases create` against the `development` target
7. **promotion** — Promotes through `staging` and `production` (recorded approvals)

The Cloud Deploy pipeline and per-environment targets are declared in
`delivery-pipeline/clouddeploy.yaml` (development → staging → production).

## Project Documentation

- [`docs/decisions/README.md`](docs/decisions/README.md) — Architecture decision log (Decision | Alternatives | Rationale | Risks)
- [`docs/observability/README.md`](docs/observability/README.md) — Observability contracts (logs, metrics, traces)
- [`docs/observability/dashboard-template.md`](docs/observability/dashboard-template.md) — Vendor-neutral dashboard blueprint (8 panels, alert policies)
- [`docs/executive-summary.html`](docs/executive-summary.html) — Reveal.js executive summary deck
- [`tickets/epics/`](tickets/epics/) — 12 product epics (EP-001 to EP-012)
- [`tickets/stories/`](tickets/stories/) — 49 implementation stories (ST-001 to ST-049)

## Implementation Rules (Non-Negotiable)

- **R1** — Every story's acceptance criteria checkbox is the source of truth.
- **R2** — Logs MUST NOT contain credential material (enforced by pino serializer allow-list).
- **R3** — Token verification uses `firebase-admin` `verifyIdToken()` only — no `jsonwebtoken` / `jose` / `jwt-decode`.
- **R4** — All six required environment variables fail-closed at startup; no defaults in source.
- **R5** — Every `bucket.file(name).getSignedUrl(...)` call passes `version: 'v4'`.
- **R6** — `backend/src/tracing.ts` is registered before any application import.
- **R7** — Texture pipeline calls `fabricCanvas.renderAll()` before `threeTexture.needsUpdate = true`.
- **R8** — Every CI gate fails closed; tooling crashes are failed runs.
- **R9** — No payment processor integration of any kind (`stripe` / `braintree` / `paypal` / etc.).
- **R10** — Migration filenames embed the originating story ID (`{ts}_ST-0NN_*.js`).
