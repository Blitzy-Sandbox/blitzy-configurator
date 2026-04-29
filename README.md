# blitzy-configurator

This repository is the monorepo housing the **StrikeForge 3D sports ball
configurator** — a full-stack product comprising a React 18, Vite, Three.js
(via R3F), and Fabric.js frontend configurator; a Node.js 20 LTS, Express, and
PostgreSQL backend with Firebase Auth and Google Cloud Storage-backed logo
storage; and a Cloud Build and Cloud Deploy CI/CD pipeline targeting Cloud
Run. The codebase is governed by 12 epics (EP-001 through EP-012) and 49
stories (ST-001 through ST-049) under [`tickets/`](tickets/), and every
implementation rule below is non-negotiable.

## Prerequisites

The following tooling must be installed locally before running any of the
quick-start commands. All runtime versions are pinned by the project and must
not be substituted.

- **Node.js 20 LTS** — install via [`nvm`](https://github.com/nvm-sh/nvm); the
  exact version is pinned in [`.nvmrc`](.nvmrc).
- **npm** — bundled with Node.js 20 LTS (no separate install).
- **Docker Engine with Compose V2** — required for the local infrastructure
  stack (PostgreSQL 15, Firebase Auth emulator, fake-gcs-server, backend).
- **`gcloud` CLI** (latest stable) — optional for local-only development;
  required for Cloud Build, Cloud Deploy, and Cloud Run interactions.
- **`jq`** — required by several verification gate commands (e.g.,
  `docker compose ps --format json | jq -r '.[].State' | sort | uniq`).

## Repository Layout

```
blitzy-configurator/
├── backend/                     Express API (Node 20 LTS + TypeScript)
├── frontend/                    React 18 + Vite + R3F + Fabric.js
├── delivery-pipeline/           Cloud Deploy pipeline and target definitions
├── docs/                        Decision log, observability, executive summary
├── tickets/                     Epics and stories (ST-001 through ST-049)
├── blitzy/                      Backlog-package governance documentation
├── cloudbuild.yaml              Cloud Build CI pipeline (7 steps)
├── skaffold.yaml                Skaffold/Cloud Deploy reference
├── docker-compose.yml           Local infra: backend, postgres, firebase emulator, fake-gcs-server
├── package.json                 Monorepo root (npm workspaces)
├── tsconfig.json                Shared TypeScript configuration (strict)
├── .eslintrc.json               Shared ESLint configuration
├── .prettierrc                  Shared formatter configuration
├── .nvmrc                       Node 20 LTS pin
├── .env.example                 Required environment variables (no defaults!)
└── .gitignore
```

## Local Development Quick-Start

Follow these steps in order. Each step assumes the previous step completed
successfully.

### 1. Select the pinned Node version

```bash
nvm use
```

This reads `.nvmrc` and selects Node.js 20 LTS. The repository's `engines`
field will reject installs on any other major version.

### 2. Configure required environment variables

Copy the template and edit the resulting `.env` file:

```bash
cp .env.example .env
```

Provide a value for every one of the following six variables:

- `DATABASE_URL` — local TCP value:
  `postgres://postgres:postgres@127.0.0.1:5432/strikeforge`. For the Cloud
  SQL Unix-socket form used on Cloud Run (per C3 dual-path), see
  `.env.example` (the `Cloud Run format` line in the `DATABASE_URL` block).
- `FIREBASE_PROJECT_ID` — must match the emulator project id (e.g.,
  `strikeforge-local`).
- `GCS_BUCKET_NAME` — any bucket name used by fake-gcs-server (e.g.,
  `strikeforge-logos-local`).
- `GCS_EMULATOR_HOST` — fake-gcs-server endpoint (e.g.,
  `http://localhost:4443`).
- `COVERAGE_THRESHOLD` — integer 0–100 representing minimum unit-test coverage
  (e.g., `80`).
- `GCP_REGION` — Cloud Deploy / Cloud Run region (e.g., `us-central1`).

**All six variables MUST be provided. Per Rule R4, the backend exits non-zero
within 2 seconds at startup if any required variable is unset — there are no
fallback defaults in source code.**

### 3. Install monorepo dependencies

```bash
npm install
```

This installs both workspaces (`backend` and `frontend`) from a single root
invocation.

### 4. Start the local infrastructure stack

```bash
docker compose up -d
```

This brings up four services: `backend`, `postgres` (15-alpine),
`firebase-auth-emulator`, and `gcs-emulator` (fake-gcs-server).

### 5. Verify all services reached running state (Gate A)

```bash
docker compose ps --format json | jq -r '.[].State' | sort | uniq
```

Expected output: `running`. This is **Phase A Gate A** per AAP §0.6.2.

### 6. Apply database migrations

```bash
docker compose exec backend npx node-pg-migrate up
```

Migrations run in dependency order: ST-031 (users + sessions) → ST-030
(designs) → ST-035 (orders + order_items).

### 7. Verify migrations created the expected schema (Gate T1-B)

```bash
docker compose exec postgres psql -U postgres -d strikeforge -c "\dt" | grep -cE "users|sessions|designs|orders|order_items"
```

Expected output: `5`. This is the migration verification step from AAP §0.6.3.

### 8. Start the frontend dev server

```bash
cd frontend && npm run dev
```

Vite serves the configurator on `http://localhost:5173` with hot module reload.

### 9. Open the configurator in a browser

Navigate to [http://localhost:5173](http://localhost:5173). The 3D ball
preview should render within 2 seconds (per ST-005 budget) and remain
interactive at ≥30 FPS during drag rotation.

## Running Tests

All test suites are executed from the repository root or per-workspace as
indicated.

- **Backend unit tests** — coverage gate enforced at `COVERAGE_THRESHOLD`:
  ```bash
  cd backend && npx jest --config jest.config.unit.ts --coverage
  ```
- **Backend integration tests** — runs against the docker-compose stack.
  The integration harness's `globalSetup` automatically defaults
  `GOOGLE_APPLICATION_CREDENTIALS` to the committed synthetic LocalGCP
  keyfile at `backend/local-dev-sa.json` so v4 signed-URL signing works
  against fake-gcs-server with zero live GCP credentials (LocalGCP
  Verification Rule):
  ```bash
  cd backend && npx jest --config jest.config.integration.ts --forceExit
  ```
- **Frontend configurator tests** — Chromium smoke and interaction tests:
  ```bash
  cd frontend && npx playwright test --project=chromium tests/configurator/
  ```
- **Frontend performance tests** — asserts ≥30 FPS sustained drag rotation and
  ≤2000 ms initial sphere render per ST-005:
  ```bash
  cd frontend && npx playwright test --project=chromium tests/performance/
  ```
- **Frontend end-to-end tests** — runs Chromium + WebKit projects across
  register → login → create → save → share → cart → order:
  ```bash
  cd frontend && npx playwright test tests/e2e/
  ```
- **Frontend visual regression tests** — compares against committed baselines
  in [`frontend/visual-baselines/`](frontend/visual-baselines/):
  ```bash
  cd frontend && npx playwright test tests/visual/
  ```

## CI/CD Overview

The Cloud Build pipeline ([`cloudbuild.yaml`](cloudbuild.yaml)) executes seven
sequential steps with explicit `waitFor` declarations, in this exact order:

1. **lint** (ST-036) — ESLint across both workspaces with `--max-warnings 0`.
2. **type-check** (ST-037) — `tsc --noEmit` across both workspaces.
3. **unit tests** (ST-038) — Jest with coverage threshold sourced from
   `COVERAGE_THRESHOLD`.
4. **integration tests** (ST-039) — Jest service-boundary tests against
   dockerized PostgreSQL, Firebase Auth emulator, and fake-gcs-server.
5. **build** (ST-040) — Multi-stage Docker image build, tagged with
   `$COMMIT_SHA` and pushed to GCR.
6. **deploy** (ST-041) — Cloud Deploy release issued against the
   `development` target.
7. **environment promotion** (ST-042) — Promotion through `development` →
   `staging` → `production` with **recorded human approvals**.

Cloud Deploy orchestration is defined in
[`delivery-pipeline/clouddeploy.yaml`](delivery-pipeline/clouddeploy.yaml),
which declares the three targets (`development`, `staging`, `production`) and
their approval gates. [`skaffold.yaml`](skaffold.yaml) provides the per-target
manifest renderer used by Cloud Deploy.

## Documentation

- [`docs/executive-summary.html`](docs/executive-summary.html) — Executive
  summary reveal.js deck (open directly in a browser).
- [`docs/decisions/README.md`](docs/decisions/README.md) — Decision log with
  implementation rationale (Decision | Alternatives | Rationale | Risks).
- [`docs/observability/README.md`](docs/observability/README.md) —
  Observability contract and local verification steps.
- [`docs/observability/dashboard-template.md`](docs/observability/dashboard-template.md)
  — Vendor-neutral dashboard template with 8 panels and alert policies.
- [`tickets/epics/`](tickets/epics/) — Twelve epic specifications (EP-001
  through EP-012).
- [`tickets/stories/`](tickets/stories/) — Forty-nine story specifications
  (ST-001 through ST-049) with acceptance-criteria checkboxes that govern
  completion per Rule R1.
- [`blitzy/documentation/Project Guide.md`](blitzy/documentation/Project%20Guide.md)
  — Backlog-package handoff narrative (read-only context).
- [`blitzy/documentation/Technical Specifications.md`](blitzy/documentation/Technical%20Specifications.md)
  — Technical specifications governance document (read-only context).

## Operational Gates and Rules

The following non-negotiable rules apply to every change. New contributors
must read these before opening a pull request.

- **Rule R1** — Every `tickets/stories/ST-NNN-*.md` acceptance-criteria
  checkbox must be checked before the corresponding gate passes. Story files
  are the single source of truth.
- **Rule R2** — No credential material in logs (passwords, bearer tokens,
  session tokens, API keys). Enforced by the pino serializer allow-list, not
  per-call discipline.
- **Rule R3** — Token verification calls Firebase Admin SDK
  `admin.auth().verifyIdToken()` exclusively. Custom JWT libraries
  (`jsonwebtoken`, `jose`, `jwt-decode`) are forbidden in `backend/`.
- **Rule R4** — All six required environment variables fail-closed at startup;
  there are no defaults in source code.
- **Rule R5** — Every `bucket.file(name).getSignedUrl(...)` call must include
  `version: 'v4'` (GCS v7 SDK requirement).
- **Rule R6** — `backend/src/tracing.ts` MUST be the first import in
  `backend/src/index.ts` so that OpenTelemetry auto-instrumentation registers
  before any `pg`, `http`, or `express` module is loaded.
- **Rule R9** — Payment processing is explicitly excluded; no payment
  processor integration, charge authorization, tokenization, or refund logic
  may appear in `backend/src`.
- **Rule R10** — Every migration filename embeds its originating story ID
  (e.g., `{timestamp}_ST-031_users_sessions.js`).

## License

See LICENSE file (if present) for usage terms. Internal repository — all
rights reserved.
