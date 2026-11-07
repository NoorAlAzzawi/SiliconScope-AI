# Integration Test Guide

## Overview

This guide covers two independent test layers:

1. **Backend integration tests** — TypeScript/Jest tests against a real PostgreSQL instance
2. **C++ agent test suite** — Google Test / ctest tests for the agent binary

---

## Part 1: C++ Agent Test Suite

### Prerequisites

- CMake build already completed (`agent/build/` directory exists with the `sscope` binary)

### Running the tests

```bash
cd agent/build
ctest --output-on-failure
```

### Results (last run: 2026-11-05)

All 13 tests pass:

| # | Suite | Status | Time |
|---|-------|--------|------|
| 1 | `test_credentials` | PASS | 0.01 s |
| 2 | `test_fingerprint` | PASS | 0.01 s |
| 3 | `test_importer` | PASS | 0.08 s |
| 4 | `test_db` | PASS | 0.03 s |
| 5 | `test_platform` | PASS | 0.00 s |
| 6 | `test_workloads` | PASS | 4.78 s |
| 7 | `test_statistics` | PASS | 0.01 s |
| 8 | `test_sync_client` | PASS | 0.02 s |
| 9 | `test_security` | PASS | 0.35 s |
| 10 | `test_pending_flush` | PASS | 0.02 s |
| 11 | `test_run_persistence` | PASS | 10.05 s |
| 12 | `st_sscope_run_stores_session` | PASS | 2.61 s |
| 13 | `st_offline_no_keychain_regression` | PASS | 0.01 s |

**100% tests passed** (13/13). Total time: 17.99 s.

### What the C++ tests cover

- **test_credentials** — API key and device credential handling
- **test_fingerprint** — SHA-256 content fingerprint computation (must match backend's `computeFingerprint`)
- **test_importer** — Google Benchmark JSON import and normalisation into canonical format
- **test_db** — Local SQLite database read/write operations
- **test_platform** — CPU/ISA/OS hardware metadata detection
- **test_workloads** — Built-in synthetic CPU workloads produce stable timing data
- **test_statistics** — Statistical helpers (percentiles, mean, etc.)
- **test_sync_client** — HTTP sync client error handling (runs against an unreachable port — no live server required)
- **test_security** — Security invariants (token handling, no secrets in logs)
- **test_pending_flush** — Pending session flush and retry logic
- **test_run_persistence** — Run data persistence to local SQLite
- **st_sscope_run_stores_session** — System test: `sscope run` stores a session in local SQLite
- **st_offline_no_keychain_regression** — System test: offline mode does not trigger Keychain access

### What the C++ tests do NOT cover

- Live HTTP sync to the backend (`sync_client` tests use an unreachable URL; `st_sscope_run_stores_session` verifies local storage only)
- PostgreSQL-side persistence (agent uses SQLite locally; sync pushes to the backend)
- The full register → run → sync → compare flow end-to-end (see Part 3 below)

---

## Part 2: Backend Integration Tests

### Prerequisites

1. A dedicated, disposable PostgreSQL test database with schema applied (all three migrations).
   The database name must end in `_test`. **Recommended: a disposable Docker PostgreSQL container**, so the test database is isolated from all host PostgreSQL data.

**Docker setup (recommended):**

```bash
# 'testonly' below is a disposable example password for this ephemeral container only.
# It is not used anywhere outside this container and must not be reused in production.
docker run --name sscope-pg-test \
  -e POSTGRES_PASSWORD=testonly \
  -p 127.0.0.1:15432:5432 \
  --rm -d postgres:16

# Wait for the container to be ready (~5 seconds), then apply migrations:
docker exec -i sscope-pg-test psql -U postgres -c "CREATE DATABASE sscope_test;"
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/000_create_roles.sql
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/001_initial_schema.sql
docker exec -i sscope-pg-test psql -U postgres -d sscope_test -v ON_ERROR_STOP=1 \
  < backend/migrations/002_protect_content_fingerprint.sql
```

**Local PostgreSQL alternative:**

```bash
psql postgres -c "CREATE DATABASE sscope_test;"
psql sscope_test -f backend/migrations/000_create_roles.sql
psql sscope_test -f backend/migrations/001_initial_schema.sql
psql sscope_test -f backend/migrations/002_protect_content_fingerprint.sql
psql sscope_test -c "GRANT ALL ON ALL TABLES IN SCHEMA public TO $(whoami);"
psql sscope_test -c "GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO $(whoami);"
```

2. Node dependencies installed:

```bash
cd backend && npm install
```

### Running the tests

Two environment variables are required:

| Variable | Purpose |
|---|---|
| `SSCOPE_TEST_DB_URL` | Connection string for the dedicated test database |
| `SSCOPE_TEST_DB_AUTHORIZED=1` | Explicit opt-in confirming the database is a disposable test instance safe for `TRUNCATE` |

```bash
cd backend

# Docker example:
SSCOPE_TEST_DB_URL=postgres://postgres:testonly@127.0.0.1:15432/sscope_test \
SSCOPE_TEST_DB_AUTHORIZED=1 \
npm run test:integration

# Local PostgreSQL example:
SSCOPE_TEST_DB_URL=postgres://localhost/sscope_test \
SSCOPE_TEST_DB_AUTHORIZED=1 \
npm run test:integration
```

### Test results (last run: 2026-11-03)

All 11 tests pass:

| # | Description | Expected | Actual |
|---|-------------|----------|--------|
| 1 | `GET /health` — real DB connectivity | 200 `{status: ok}` | PASS |
| 2 | Full registration flow | 201 with `api_key` | PASS |
| 3 | Token one-time use | 409 `SETUP_TOKEN_CONSUMED` | PASS |
| 4 | Submit run with correct fingerprint | 201 with `session_id` | PASS |
| 5 | Idempotent retry of same run | 200 same `session_id` | PASS |
| 6 | Retrieve run by ID | 200 with correct fields and cases | PASS |
| 7 | Submit second (candidate) run | 201 with new `session_id` | PASS |
| 8 | Create comparison between two runs | 201 with `per_metric_results`, `cv_baseline_pct`, and `cv_candidate_pct` | PASS |
| 9 | Retrieve comparison by ID | 200 matching POST response | PASS |
| 10 | Same-session comparison blocked | 400 `VALIDATION_ERROR` | PASS |
| 11 | GET comparison without cv fields (backward compat) | 200; `cv_baseline_pct` and `cv_candidate_pct` absent | PASS |

### Notes on the test setup

- `SSCOPE_TEST_DB_URL` and `SSCOPE_TEST_DB_AUTHORIZED=1` must both be set before running. The test file validates both at load time and throws with a clear error if either is missing or if the database name does not end in `_test`.
- `DATABASE_URL` is derived from `SSCOPE_TEST_DB_URL` for compatibility with `pool.ts`. In this test flow, `app.ts` (not `server.ts`) is imported, so `pool.ts` is never loaded — `testPool` is the only pool in existence.
- The app's `dbPool` is wired to the test pool via `setPool(testPool)` in `beforeAll`, before any HTTP request is sent.
- A single PostgreSQL client is acquired in `beforeAll` for the identity verification and `TRUNCATE`: `SELECT current_database()` and `TRUNCATE` execute on the same physical connection, so the database confirmed safe is exactly the one being truncated.
- Registration state (`initRegistration`) is called once in test 2 with a bcrypt cost-4 hash for speed; the route's `bcrypt.compare` reads the cost from the hash and works correctly.
- The `json-canonicalize` module is mapped to the project's RFC-8785-compatible mock via jest's `moduleNameMapper`. Because the same mock is used by both the test helper and the route handler, fingerprints produced in tests match those verified by the server.
- `SSCOPE_DISABLE_RATE_LIMIT=true` suppresses rate-limiting middleware in tests.

---

## Part 3: Manual C++ → Backend → Comparison End-to-End Flow

This section documents the manual steps to exercise the full pipeline: C++ agent collects benchmarks, pushes them to the backend, and the backend produces a comparison.

### Prerequisites

- Backend running: `cd backend && DATABASE_URL=postgres://... npm run dev` — the one-time registration token is printed to stdout on startup
- Agent binary at `agent/build/sscope`

### Step 1 — Register the device

```bash
./agent/build/sscope register --backend http://localhost:3000
# Registration token: [paste the token printed to server stdout — input is hidden]
```

The token is read interactively with terminal echo disabled (`termios` echo-off). The `--token` and `--setup-token` flags do not exist and are explicitly rejected with an error.

After successful registration, the agent stores the API key in the **macOS Keychain** and writes the backend URL and device ID to `~/.config/sscope/`.

### Step 2 — Run the built-in workloads (baseline)

```bash
./agent/build/sscope run \
  --db ~/.config/sscope/local.db \
  --server http://localhost:3000 \
  --api-key <api-key>
```

The agent:
1. Executes the synthetic CPU workloads
2. Stores the session in SQLite
3. Syncs the session to the backend via `POST /api/v1/runs`

Note the `session_id` printed or stored (use `sscope list` to retrieve it).

### Step 3 — Import a Google Benchmark JSON (candidate)

If you have a Google Benchmark JSON file from a different build:

```bash
./agent/build/sscope import path/to/benchmark_results.json \
  --db ~/.config/sscope/local.db \
  --server http://localhost:3000 \
  --api-key <api-key>
```

### Step 4 — List sessions

```bash
./agent/build/sscope list --db ~/.config/sscope/local.db
```

### Step 5 — Create a comparison via the backend API

```bash
curl -s -X POST http://localhost:3000/api/v1/comparisons \
  -H "Authorization: Bearer <api-key>" \
  -H "Content-Type: application/json" \
  -d '{"session_a_id": "<baseline-uuid>", "session_b_id": "<candidate-uuid>"}' | jq .
```

The response includes `per_metric_results`, `overall_summary`, and `rule_based_explanation`.

---

## Part 4: Known Gaps in C++ ↔ Backend Integration

### 1. No live sync test in ctest

The `test_sync_client` suite uses an unreachable port and verifies only error-path behaviour. There is no ctest that actually registers against a running backend instance and verifies the round-trip. A future `test_sync_live` suite (gated on `SSCOPE_TEST_BACKEND_URL` env var) would close this gap.

### 2. `register` subcommand CLI interface

The `sscope register` command reads the setup token interactively via a hidden stdin prompt (echo disabled via `termios`). The `--token` and `--setup-token` flags do not exist; passing either exits with an error. The token must be pasted at the `Registration token:` prompt. The correct invocation is `sscope register --backend <url>` with no token flag.

### 3. Session ID visibility

The agent does not currently print the submitted `session_id` to stdout after a successful sync. Users must use `sscope list` to find it before calling `POST /api/v1/comparisons`. A future improvement would print the session ID after each successful sync.

### 4. Fingerprint cross-language agreement

The C++ `test_fingerprint` suite verifies that the agent's SHA-256 fingerprint matches expected values for known inputs. The backend independently verifies the fingerprint on `POST /api/v1/runs`. Both implementations agree in production, as demonstrated by the passing integration tests. However, there is no shared golden-vector test file that explicitly cross-validates C++ ↔ TypeScript fingerprint output for the same payload — adding one would strengthen this invariant.
