# SiliconScope AI

A developer tool for reproducible benchmark history, statistical regression detection, and hardware-aware run comparison. Built as a native C++20 agent, Node.js/TypeScript backend, and React dashboard — targeted at performance-sensitive macOS development workflows.

---

## Overview

Performance regressions are easy to introduce and hard to notice. SiliconScope AI tracks benchmark runs across time, detects statistically significant changes, and surfaces confounding factors (CPU model, OS version, build type, ISA) that affect comparability.

The agent runs locally on the developer's machine, stores results in a local SQLite database, and syncs to a PostgreSQL backend over HTTP. The backend computes a deterministic SHA-256 content fingerprint for each run and verifies it against the agent's submitted fingerprint before persisting. The React dashboard provides a paginated run history, free-text search, and a side-by-side comparison view with per-metric classification and an exportable JSON summary.

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
└──────────────────────────────────────────────────────────────┘
```

---

## Technology Stack

| Component | Technology |
|-----------|-----------|
| **Agent** | C++20, CMake ≥ 3.21, SQLite 3 (WAL mode, amalgamation), libcurl, Security.framework (macOS Keychain), nlohmann/json (single-header), Ryu d2s (double→string) |
| **Backend** | Node.js 20, Express 4.18, TypeScript 5.2, PostgreSQL 16, pino 9.5 (structured logging), bcryptjs, json-canonicalize (RFC 8785 JCS), uuid |
| **Dashboard** | React 19, React Router 7, Vite 8, TypeScript, Axios, oxlint |
| **Testing** | GoogleTest + ctest (C++), Jest 29 + Supertest (TypeScript), PostgreSQL integration tests |

---

## Key Design Decisions

- **Offline-first sync**: Benchmark results are written to a local SQLite database immediately. A `flush_pending_sessions()` call fires automatically before `run`, `import`, and `compare` when the backend is reachable, retrying any queued runs. The agent continues to work without network access.

- **RFC 8785 content fingerprinting**: Each session payload is serialized to JSON Canonical Form (RFC 8785 JCS) and SHA-256 hashed. The hash is computed independently by both the C++ agent and the TypeScript backend; a mismatch causes the submission to be rejected with HTTP 422. Cross-language agreement is verified by shared test vectors.

- **Provenance immutability**: PostgreSQL trigger blocks `UPDATE` on `content_fingerprint`, `session_id`, `device_id`, and other provenance fields in the `sessions` table after insert. Historical benchmark data cannot be silently altered.

- **Import-only security boundary**: The JSON import pipeline runs five validation stages (file size, parse depth, row count, field-level validation, storage). No code in an imported benchmark JSON file is executed at any point; validation is data-only.

- **Conditional Keychain access**: `load_api_key()` is called only when a backend URL is configured. The agent does not trigger a Keychain dialog when running offline or in environments without backend connectivity.

- **Three-credential architecture**: Agent authenticates with a 256-bit random API key stored in the macOS Keychain. Device registration uses a one-time setup token (printed once to backend stdout at startup, consumed on first use). Dashboard login uses a bcrypt-hashed password (cost 12) set via the `SSCOPE_DASHBOARD_PASSWORD` environment variable.

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

All test suites cover fingerprint computation, import pipeline validation (including security boundary tests), local database operations, platform metadata detection, synthetic workloads, statistical helpers, sync client error handling, and security invariants.

### Backend unit tests

```bash
cd backend && npm test
```

133 tests pass; 8 are skipped. The skipped tests require a live PostgreSQL instance, a running backend process, or manual Keychain interaction — all have documented `test.skip` annotations. No database is required to run `npm test`.

### Backend integration tests

Integration tests are separate from unit tests and require an explicitly authorized, dedicated test database. **Recommended: a disposable Docker PostgreSQL container.**

```bash
# Docker setup.
# 'testonly' below is a disposable example password for this ephemeral container only.
# It is not used anywhere outside this container and must not be reused in production.
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

# Run the 11 integration tests:
cd backend
SSCOPE_TEST_DB_URL=postgres://postgres:testonly@127.0.0.1:15432/sscope_test \
SSCOPE_TEST_DB_AUTHORIZED=1 \
npm run test:integration
```

`SSCOPE_TEST_DB_AUTHORIZED=1` is an explicit opt-in confirming the target database is a dedicated, disposable instance safe for destructive test setup (`TRUNCATE`). The tests refuse to run without it. See [`docs/INTEGRATION_TEST_GUIDE.md`](docs/INTEGRATION_TEST_GUIDE.md) for the local PostgreSQL alternative and full details.

The integration suite runs 11 tests covering the full HTTP pipeline: registration, idempotent run submission, fingerprint verification, pagination, session retrieval, comparison creation, eligibility enforcement, and backward compatibility with pre-J2 comparison records.

---

## Security

The full threat model is in [`docs/SECURITY.md`](docs/SECURITY.md). Brief summary:

- **API keys**: 256-bit cryptographically random, stored only in the macOS Keychain (agent side) and as a bcrypt hash in PostgreSQL (backend side).
- **Setup token**: 32-byte cryptographically random, single-use, printed to backend stdout (not to an HTTP endpoint), consumed on first `POST /api/v1/register`.
- **Dashboard authentication**: Password verified with `bcryptjs` (cost 12). Session cookie is `httpOnly`, `sameSite: strict`.
- **Rate limiting**: Applied to all API endpoints to prevent brute-force and flooding.
- **Import validation**: Five-stage pipeline rejects oversized files (`>50 MiB`), excessive nesting depth (`>32`), oversized batch counts (`>10,000`), control characters in names, and malformed fields — before any database interaction.
- **No code execution**: The JSON import pipeline is data-only. No imported file content is passed to `exec`, `system`, or `popen`.

---

## End-to-End Demo Overview

The full manual walkthrough is in [`docs/INTEGRATION_TEST_GUIDE.md`](docs/INTEGRATION_TEST_GUIDE.md). The high-level flow:

1. Start the backend (`npm run dev`) and note the one-time setup token from stdout.
2. Register the agent (`sscope register --backend http://localhost:3000`) — paste the token at the hidden prompt.
3. Run the built-in CPU and memory workloads (`sscope run --server http://localhost:3000`). Results are stored locally and synced automatically.
4. Import a Google Benchmark JSON file from a different build configuration (`sscope import benchmark_results.json --server http://localhost:3000`).
5. List sessions (`sscope list`) to retrieve session IDs.
6. Request a comparison via the backend API (`POST /api/v1/comparisons`) — the response includes per-metric regression classification (`IMPROVEMENT`, `REGRESSION`, `NO_CHANGE`, `INCONCLUSIVE`), confounding factor warnings, and a natural-language explanation.
7. View the full run history and comparison details in the React dashboard at `http://localhost:5173`.

---

## Project Status

Phase 1 MVP is complete (November 2026). macOS is the validated platform.

**In scope for Phase 1**: Device registration, synthetic CPU and memory workloads, Google Benchmark JSON import with 5-stage validation, offline-first SQLite storage with automatic HTTP sync, statistical regression detection, React dashboard with run history and comparison view, security hardening.

**Planned post-Phase 1**: Linux agent support, LLM-powered diagnostic explanations, CI/CD pipeline integration, multi-user backend.

See [`PROJECT.md`](PROJECT.md) for the full scope definition and [`docs/`](docs/) for architecture, API contracts, benchmark methodology, and security specification.

---

## License

Copyright © 2026 Noor Al Azzawi. All rights reserved.

This project is proprietary. No permission is granted to use, copy, modify, or distribute the software without prior written permission from the copyright holder.
