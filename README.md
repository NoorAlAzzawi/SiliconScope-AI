# SiliconScope AI

A developer tool for reproducible benchmark history, statistical regression detection, and hardware-aware run comparison. Built as a native C++20 agent, Node.js/TypeScript backend, and React dashboard — targeted at performance-sensitive macOS development workflows.

---

## Overview

Performance regressions are easy to introduce and hard to notice. SiliconScope AI tracks benchmark runs across time, detects statistically significant changes, and surfaces confounding factors (CPU model, OS version, build type, ISA) that affect comparability.

The agent runs locally on the developer's machine, stores results in a local SQLite database, and syncs to a PostgreSQL backend over HTTP. The backend computes a deterministic SHA-256 content fingerprint for each run and verifies it against the agent's submitted fingerprint before persisting. The React dashboard provides a paginated run history, free-text search, side-by-side comparison with per-metric statistical classification, mean timing display, coefficient-of-variation reporting, and an exportable JSON summary.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Developer Machine                                           │
│                                                              │
│  ┌─────────────────────────┐                                 │
│  │  sscope CLI (C++20)     │  Synthetic workloads, import    │
│  │  SQLite local store     │  Google Benchmark JSON          │
│  │  macOS Keychain auth    │  Offline-first, auto-sync       │
│  └────────────┬────────────┘                                 │
│               │  POST /api/v1/runs  (Bearer API key)         │
└───────────────┼──────────────────────────────────────────────┘
                │
                ▼
┌──────────────────────────────────────────────────────────────┐
│  Backend (Node.js / TypeScript / Express)                    │
│                                                              │
│  ┌────────────┐  ┌────────────┐  ┌──────────────────────┐    │
│  │ /register  │  │  /runs     │  │  /comparisons        │    │
│  │ one-time   │  │  POST+GET  │  │  statistical         │    │
│  │ setup token│  │  idempotent│  │  regression engine   │    │
│  └────────────┘  └────────────┘  └──────────────────────┘    │
│                                                              │
│  PostgreSQL 16 — provenance-immutable schema                 │
└──────────────────────────────┬───────────────────────────────┘
                               │  REST API (session cookie auth)
                               ▼
┌──────────────────────────────────────────────────────────────┐
│  Dashboard (React 19 / Vite 8)                               │
│                                                              │
│  Run history list · Session detail · Side-by-side compare    │
│  Pagination · Free-text search · JSON export                 │
│  Shared authenticated layout · Session-aware logout nav      │
└──────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| **Agent** | C++20, CMake ≥ 3.21, SQLite 3 (WAL mode, amalgamation), libcurl, Security.framework (macOS Keychain), nlohmann/json (single-header), Ryu d2s (double→string) |
| **Backend** | Node.js 20, Express 4.18, TypeScript 5.2, PostgreSQL 16, pino 9.5 (structured logging), bcryptjs, json-canonicalize (RFC 8785 JCS), uuid |
| **Dashboard** | React 19, React Router 7, Vite 8, TypeScript 7.0, Axios, oxlint |
| **Testing** | GoogleTest + ctest (C++), Jest 29 + Supertest (backend), Vitest 5.1 + React Testing Library 16.3 (dashboard components), Playwright 1.65 (E2E) |

---

## Key Design Decisions

- **Offline-first sync**: Benchmark results are written to a local SQLite database immediately. A `flush_pending_sessions()` call fires automatically before `run`, `import`, and `compare` when the backend is reachable, retrying any queued runs. The agent continues to work without network access.

- **RFC 8785 content fingerprinting**: Each session payload is serialized to JSON Canonical Form (RFC 8785 JCS) and SHA-256 hashed. The hash is computed independently by both the C++ agent and the TypeScript backend; a mismatch causes the submission to be rejected with HTTP 422. Cross-language agreement is verified by shared test vectors.

- **Provenance immutability**: PostgreSQL trigger blocks `UPDATE` on `content_fingerprint`, `session_id`, `device_id`, and other provenance fields in the `sessions` table after insert. Historical benchmark data cannot be silently altered.

- **Import-only security boundary**: The JSON import pipeline runs five validation stages (file size, parse depth, row count, field-level validation, storage). No code in an imported benchmark JSON file is executed at any point; validation is data-only.

- **Conditional Keychain access**: `load_api_key()` is called only when a backend URL is configured. The agent does not trigger a Keychain dialog when running offline or in environments without backend connectivity.

- **Three-credential architecture**: Agent authenticates with a 256-bit random API key stored in the macOS Keychain. Device registration uses a one-time setup token (printed once to backend stdout at startup, consumed on first use). Dashboard login uses a bcrypt-hashed password (cost 12) set via the `SSCOPE_DASHBOARD_PASSWORD` environment variable.

---

## Implemented Functionality

### CLI Agent (C++20)

- `sscope register --backend <url>` — registers the device, stores API key in Keychain
- `sscope run [--server <url>]` — executes synthetic CPU-integer and memory workloads, stores results locally, syncs to backend
- `sscope import <file.json> [--server <url>]` — imports Google Benchmark JSON, applying 5-stage validation
- `sscope list` — lists locally stored sessions with IDs, timestamps, and sync status
- `sscope compare <session_a> <session_b> [--server <url>]` — requests statistical comparison via backend

### Backend (Node.js / TypeScript)

- `POST /api/v1/register` — one-time device registration with single-use setup token
- `POST /api/v1/runs` — idempotent run submission with SHA-256 fingerprint verification
- `GET /api/v1/runs` — paginated run history with optional free-text search (ILIKE on run name and canonical benchmark name)
- `GET /api/v1/runs/:id` — single run detail with full raw measurement rows
- `POST /api/v1/comparisons` — Welch's t-test statistical comparison engine
- `GET /api/v1/comparisons/:id` — comparison result retrieval (returns stored JSONB unchanged)
- `POST /dashboard/login` / `POST /dashboard/logout` — bcrypt session authentication

### Statistical Engine

The comparison engine applies Welch's t-test with Holm–Bonferroni correction across all metrics in a comparison. Per metric, it returns:

- **Classification**: Regression Detected, Possible Regression, No Change, Inconclusive — with specific guard conditions for constant-sample paths, low N, and not-evaluated states
- **delta_pct** and **regression_effect**: signed relative change with practical threshold classification
- **n_baseline / n_candidate**: raw sample counts
- **mean_baseline_ns / mean_candidate_ns**: actual mean timings in nanoseconds, formatted as ns / µs / ms in the dashboard and rule-based explanation
- **cv_baseline_pct / cv_candidate_pct**: coefficient of variation; `high_cv` flag and caveat text emitted when CV > 5%
- **confounding_factors**: CPU model, OS version, build type, ISA mismatches flagged by severity
- **ciEligible / ciRefusalReasons**: structured CI gate evaluation
- **rule_based_explanation**: deterministic natural-language summary; labeled "Automated Summary" in the dashboard

Statistical limitations are surfaced explicitly: low-N warnings, high-variance caveats, constant-sample detection, and confounding factor alerts. The engine does not use speculative or causal language.

### Dashboard (React 19)

- Authenticated login/logout with session cookie; shared `AuthLayout` navigation bar with logout on all protected pages
- Run history list with pagination and debounced free-text search
- Session detail view with raw measurement rows
- Comparison result page:
  - Overall summary label (Regression Detected / Possible Regression / No Change / Inconclusive) with count breakdown
  - Per-metric table: Canonical Name, Project, Metric, Classification, Change, Baseline N, Candidate N, Baseline Mean, Candidate Mean, Baseline CV, Candidate CV
  - Caveats row (per metric) for high-variance warnings
  - Confounding factors table
  - Rule-based automated summary
  - Export JSON button (downloads full comparison payload)

---

## Recent Improvements

### Dashboard logout handling in RunsPage (commit 2a0bcb4)

Added logout button, session token management, and authentication redirect to `RunsPage`, handling expired and invalid session states.

### Shared authenticated layout and API proxy fix (commit 6e0d8b1)

- Introduced `AuthLayout.tsx` as a shared wrapper for all authenticated pages, providing a consistent navigation bar with a logout button — replacing the per-page logout logic added in 2a0bcb4
- Fixed API base URL in `api/client.ts` so dashboard requests route correctly through Vite's development proxy to the backend
- Factored logout into a reusable `api/auth.ts` module

### Dashboard component tests, E2E tests, and comparison result accuracy (commit aff0f7e)

**Phase 2 — Dashboard test infrastructure**

- Added Vitest 5.1 + React Testing Library 16.3 as the dashboard unit/component test framework; 48 tests across 7 test files, all passing
- Added Playwright 1.65 E2E smoke suite (7 tests) covering the full browser-driven login → runs list → comparison flow; all API responses are mocked via `page.route()` — no live backend required
- Added `renderWithRoute` test utility for components that consume React Router params
- Used explicit `afterEach(cleanup)` (Vitest 5 does not auto-register RTL cleanup)

**Phase 3 — Comparison result accuracy**

- **Fixed misleading explanation labels**: the rule-based explanation previously displayed "Baseline mean: 30 samples" using the sample count in a mean-labeled field. It now correctly shows "Baseline: N=30, mean=X.XXX ms" with time values formatted in appropriate units (ns / µs / ms)
- **Added mean timing fields**: `mean_baseline_ns` and `mean_candidate_ns` are now computed by the statistical engine, mapped through the POST route, stored in JSONB, exposed through the GET endpoint, and displayed in the per-metric table
- **Added caveats propagation**: per-metric `caveats` (e.g. high-variance warnings with actual CV values) are mapped through the POST route and rendered as a row below each affected metric in the dashboard
- **CV field mapping fix**: `cv_baseline_pct` and `cv_candidate_pct` were computed by the engine but not mapped in the POST route handler; they are now correctly included in every new comparison result
- **Backward compatibility**: comparisons created before these fields existed continue to work; all new fields fall back to `—` without errors

---

## Prerequisites

**Platform**: macOS (Ventura 13.0 or later). Linux support is planned; Windows is out of scope for Phase 1.

**Agent build**:
- Xcode Command Line Tools (provides Clang with C++20, `Security.framework`, `libcurl`)
- CMake ≥ 3.21

**Backend and dashboard**:
- Node.js 20 or later
- PostgreSQL 16

---

## Setup

### 1. Build the agent

```bash
cmake -S agent -B agent/build -DCMAKE_BUILD_TYPE=Release
cmake --build agent/build
```

The build links sqlite3 and ryu from the vendored sources in `agent/third_party/`. No external package manager is required.

### 2. Set up PostgreSQL

Create the database and apply the three migrations in order:

```bash
createdb sscope
psql sscope -f backend/migrations/000_create_roles.sql
psql sscope -f backend/migrations/001_initial_schema.sql
psql sscope -f backend/migrations/002_protect_content_fingerprint.sql
```

> **Note**: `000_create_roles.sql` creates the `sscope_migrations` and `sscope_app` roles at the **PostgreSQL cluster level** (they are shared across all databases on the instance). The script uses `IF NOT EXISTS` guards and is safe to rerun. Running it requires a PostgreSQL superuser account.

### 3. Configure the backend

```bash
cp backend/.env.example backend/.env
```

Edit `backend/.env`:

```
DATABASE_URL=postgres://sscope_app:REPLACE_WITH_STRONG_PASSWORD@localhost:5432/sscope
SSCOPE_DASHBOARD_PASSWORD=   # bcrypt hash (cost 12) of your chosen dashboard password
PORT=3000
```

`SSCOPE_DASHBOARD_PASSWORD` must be set before the backend accepts dashboard logins. Without it, `POST /dashboard/login` returns HTTP 503.

To generate a hash:
```bash
node -e "const b = require('bcryptjs'); b.hash('yourpassword', 12).then(h => console.log(h));"
```

### 4. Install dependencies

```bash
cd backend && npm install
cd dashboard && npm install
```

### 5. Start the backend

```bash
cd backend && npm run dev
```

On startup, the backend prints a one-time registration token to stdout:

```
[sscope] Setup token: a3f8c2... (valid until first use)
```

Copy this token — it is consumed on first use.

### 6. Register the agent

```bash
./agent/build/sscope register --backend http://localhost:3000
# Registration token: [paste the token — input is hidden]
```

The agent stores the API key in the macOS Keychain and the backend URL in `~/.config/sscope/`.

### 7. Start the dashboard

```bash
cd dashboard && npm run dev
```

Navigate to `http://localhost:5173` and log in with the password whose hash you set in step 3.

---

## Running Tests

### C++ agent tests

```bash
cd agent/build
ctest --output-on-failure
```

**13 CTest targets, all passing** (≈17 s). The suite comprises two categories:

- **11 GoogleTest suites — 157 individual test cases**: Credentials (4), RFC 8785 JCS fingerprint (41), Import pipeline (27), Local database (13), Platform metadata (8), Synthetic workloads (16), Statistics (9), Sync client (12), Security invariants (11), Pending flush (12), Run persistence (4)
- **2 system-level integration tests** that compile and run the `sscope` binary end-to-end: `st_sscope_run_stores_session` and `st_offline_no_keychain_regression`

### Backend tests (Jest + Supertest)

```bash
cd backend && npm test
```

**138 tests pass; 8 are skipped** across 8 test suites. The skipped tests require a live PostgreSQL instance, a running backend process, or manual Keychain interaction — all have documented `test.skip` annotations. No database is required to run `npm test`.

Suites: comparison engine (mean fields, CV fields, guard conditions, Holm–Bonferroni), explanation generator (label correctness, mean formatting), route handlers (fingerprint verification, pagination, CV mapping, confounding factor display), statistics, and utilities.

### Dashboard component tests (Vitest + React Testing Library)

```bash
cd dashboard && npm test
```

**48 tests pass** across 7 test files:

| File | Component | Coverage |
|------|-----------|----------|
| `AuthLayout.test.tsx` | `AuthLayout` | Logout button rendering, logout success/failure, error clearing |
| `ProtectedRoute.test.tsx` | `ProtectedRoute` | Loading state, unauthenticated redirect, authenticated rendering |
| `LoginPage.test.tsx` | `LoginPage` | Form rendering, submission, 401/503/network error states |
| `RunsPage.test.tsx` | `RunsPage` | List rendering, empty state, 503 error, checkbox selection, pagination |
| `RunDetailPage.test.tsx` | `RunDetailPage` | Spinner, run metadata, benchmark table, 404/503 errors |
| `ComparePage.test.tsx` | `ComparePage` | UUID inputs, search param pre-fill, auto-trigger, 400/404/503, in-flight state |
| `ComparisonResultPage.test.tsx` | `ComparisonResultPage` | Summary label, per-metric table, mean columns, CV columns, caveats row, old-JSONB backward compat, export |

### Dashboard E2E tests (Playwright)

```bash
cd dashboard && npx playwright test
```

**7 E2E smoke tests**, all passing. The Playwright config (`playwright.config.ts`) starts an isolated Vite dev server on port **5178** and intercepts all API calls via `page.route()` — **no live backend or database is required**. Mocked endpoints: `/dashboard/login`, `/dashboard/logout`, `/api/v1/runs`, `/api/v1/runs/:id`, `/api/v1/comparisons`, `/api/v1/comparisons/:id`.

Tests cover: unauthenticated redirect to `/login`, login form submission, run history rendering, run detail navigation, two-run selection and comparison trigger, comparison result page (summary label, per-metric table, export button), and logout with subsequent re-authentication check.

### Backend integration tests

Integration tests require an explicitly authorized, dedicated test database. **Recommended: a disposable Docker PostgreSQL container.**

```bash
docker run --name sscope-pg-test \
  -e POSTGRES_PASSWORD=testonly \
  -p 127.0.0.1:15432:5432 \
  --rm -d postgres:16

docker exec -i sscope-pg-test psql -U postgres -c "CREATE DATABASE sscope_test;"
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/000_create_roles.sql
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/001_initial_schema.sql
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/002_protect_content_fingerprint.sql

cd backend
SSCOPE_TEST_DB_URL=postgres://postgres:testonly@127.0.0.1:15432/sscope_test \
SSCOPE_TEST_DB_AUTHORIZED=1 \
npm run test:integration
```

`SSCOPE_TEST_DB_AUTHORIZED=1` is an explicit opt-in confirming the target database is a dedicated, disposable instance safe for destructive test setup (`TRUNCATE`). The tests refuse to run without it. See [`docs/INTEGRATION_TEST_GUIDE.md`](docs/INTEGRATION_TEST_GUIDE.md) for the local PostgreSQL alternative and full details.

The integration suite runs 11 tests covering the full HTTP pipeline: registration, idempotent run submission, fingerprint verification, pagination, session retrieval, comparison creation, eligibility enforcement, and backward compatibility with pre-Phase 3 comparison records.

### Test summary

| Suite | Framework | Result |
|-------|-----------|--------|
| C++ agent (11 GoogleTest suites) | GoogleTest + ctest | 157 cases pass |
| C++ agent (system tests) | ctest binary | 2 pass |
| Backend unit + route tests | Jest 29 + Supertest | 138 pass, 8 skipped |
| Dashboard component tests | Vitest 5.1 + RTL 16.3 | 48 pass |
| Dashboard E2E (mocked API) | Playwright 1.65 | 7 pass |
| Backend integration (live DB) | Jest 29 | 11 pass |

---

## Security

The full threat model is in [`docs/SECURITY.md`](docs/SECURITY.md). Brief summary:

- **API keys**: 256-bit cryptographically random, stored only in the macOS Keychain (agent side) and as a bcrypt hash in PostgreSQL (backend side).
- **Setup token**: 32-byte cryptographically random, single-use, printed to backend stdout (not to an HTTP endpoint), consumed on first `POST /api/v1/register`.
- **Dashboard authentication**: Password verified with `bcryptjs` (cost 12). Session cookie is `HttpOnly`, `SameSite=Strict`, `Max-Age=86400` (24 h). The `Secure` flag is added only when `NODE_ENV=production`.
- **Rate limiting**: Three in-memory sliding-window limiters — general routes (100 req/min), `/api/v1/register` (10 req/min), `/dashboard/login` (60 req/min). In-memory only: limits reset on server restart and are not shared across processes.
- **Import validation**: Five-stage pipeline rejects oversized files (`>50 MiB`), excessive nesting depth (`>32`), oversized batch counts (`>10,000`), control characters in names, and malformed fields — before any database interaction.
- **No code execution**: The JSON import pipeline is data-only. No imported file content is passed to `exec`, `system`, or `popen`.
- **Session store**: In-memory (`Map<token, {deviceId, expiresAt}>`). Sessions do not survive backend restarts. Production hardening (Redis or database-backed store) is out of scope for Phase 1.

---

## End-to-End Demo Overview

The full manual walkthrough is in [`docs/INTEGRATION_TEST_GUIDE.md`](docs/INTEGRATION_TEST_GUIDE.md). The high-level flow:

1. Start the backend (`npm run dev`) and note the one-time setup token from stdout.
2. Register the agent (`sscope register --backend http://localhost:3000`) — paste the token at the hidden prompt.
3. Run the built-in CPU and memory workloads (`sscope run --server http://localhost:3000`). Results are stored locally and synced automatically.
4. Import a Google Benchmark JSON file from a different build configuration (`sscope import benchmark_results.json --server http://localhost:3000`).
5. List sessions (`sscope list`) to retrieve session IDs.
6. Request a comparison via the backend API (`POST /api/v1/comparisons`) — the response includes per-metric regression classification, mean timings, CV values, confounding factor warnings, and a natural-language explanation.
7. View the full run history and comparison details in the React dashboard at `http://localhost:5173`.

---

## Project Status

Phase 1 MVP is complete (November 2026). macOS is the validated platform.

**Completed**:
- Device registration, synthetic CPU and memory workloads, Google Benchmark JSON import with 5-stage validation
- Offline-first SQLite storage with automatic HTTP sync and idempotent run submission
- Statistical regression detection: Welch's t-test, Holm–Bonferroni correction, CV reporting, confounding factor detection, CI eligibility gate
- React dashboard: authenticated sessions with shared navigation layout, run history with free-text search, comparison result view with mean timings and caveats, JSON export
- Comprehensive test suite: 157 C++ GoogleTest cases + 2 system tests, 138 backend tests, 48 dashboard component tests, 7 E2E tests, 11 integration tests

**Production hardening — planned post-Phase 1**:
- Replace in-memory session store with a persistent, process-independent store (Redis or database-backed) so sessions survive backend restarts
- Replace in-memory rate limiter with a distributed implementation shared across backend processes
- Linux agent support
- LLM-powered diagnostic explanations
- CI/CD pipeline integration
- Multi-user backend

See [`PROJECT.md`](PROJECT.md) for the full scope definition and [`docs/`](docs/) for architecture, API contracts, benchmark methodology, and security specification.

---

## License

Copyright © 2026 Noor Al Azzawi. All rights reserved.

This project is proprietary. No permission is granted to use, copy, modify, or distribute the software without prior written permission from the copyright holder.
