# SiliconScope AI — Architecture

**Status:** Approved  
**Version:** 1.0.0  
**Last updated:** 2026-11-05  
**Authoritative scope reference:** `PROJECT.md`  
**Security specification:** `docs/SECURITY.md`  
**Benchmark specification:** `docs/BENCHMARK_SPEC.md`

---

## 1. Purpose and Scope

This document resolves the open architectural questions assigned to `ARCHITECTURE.md` in `PROJECT.md` §9:

| Open Question | Resolution | Section |
|---|---|---|
| OQ-6 | Backend deployment topology for development and production | §10 |
| OQ-8 | Local persistence mechanism | §4.2 |
| OQ-9 | Synchronization trigger, conflict handling, offline compare behavior | §4.3, §4.4 |
| OQ-4 | Agent distribution mechanism (partial) | §11 |

Decisions recorded here are authoritative. Where a detail is deferred to `docs/API_CONTRACTS.md`, that document is an explicit implementation blocker — see §13.

This document does not define API endpoint schemas, the canonical fingerprint algorithm, or API versioning strategy. Those belong in `docs/API_CONTRACTS.md`.

---

## 2. Repository Structure

```
siliconscope/
├── agent/                  # C++20, CMake
│   ├── src/
│   ├── include/
│   ├── tests/
│   └── CMakeLists.txt
├── backend/                # Node.js 20 LTS, TypeScript, Express 4
│   ├── src/
│   │   ├── routes/
│   │   ├── middleware/
│   │   ├── db/
│   │   ├── services/
│   │   └── static/         # React SPA build output; served at same origin as the API
│   └── migrations/         # SQL migration files; executed by sscope_migrations account only
├── dashboard/              # React 18, TypeScript, Vite
│   ├── src/
│   └── vite.config.ts
├── docs/
│   ├── SECURITY.md
│   ├── BENCHMARK_SPEC.md
│   └── API_CONTRACTS.md    # to be written; blocks backend API and idempotent sync implementation
├── ARCHITECTURE.md         # this document
└── docker-compose.yml      # local PostgreSQL development environment only
```

---

## 3. Component Overview

| Component | Language / Runtime | Role |
|---|---|---|
| `agent` | C++20, CMake | CLI: execute synthetic benchmarks, import results, sync to backend, compare |
| `backend` | Node.js 20 LTS, TypeScript, Express 4 | REST API, statistical engine, session management, serves dashboard SPA |
| `dashboard` | React 19, React Router 7, Vite 8, TypeScript | SPA served from `backend/src/static/` at the same origin — no separate server |
| PostgreSQL 16 | — | Hosted and remote persistence for all submitted run data |
| SQLite 3 (WAL) | — | Local agent persistence at `~/.config/sscope/local.db`; agent-exclusive |

**SQLite belongs exclusively to the local C++ agent.** The backend connects only to PostgreSQL. No backend code reads or writes SQLite.

---

## 4. Native Agent (C++20)

### 4.1 CLI Commands

The following commands constitute the complete agent CLI for the MVP. `sscope run` executes only the synthetic benchmark workloads defined in `docs/BENCHMARK_SPEC.md` §5.2 (e.g., `synthetic.cpu.integer`, `synthetic.memory.seq_read/4k`). It does not accept arbitrary executables, user-supplied binary paths, or shell commands. The workload identifiers are an enumerated, fixed set.

| Command | Description |
|---|---|
| `sscope run [suite\|workload]` | Execute the named synthetic workload or the full suite. Workload identifiers are defined in `docs/BENCHMARK_SPEC.md` §5.2. Without a workload argument, runs the full suite. Persists the result locally before exit. Exit 0 on success. |
| `sscope run --commit <sha>` | Associate the synthetic run with a user-supplied Git commit SHA as contextual metadata. The SHA is not validated against any repository and is stored verbatim as `"user-supplied"`. |
| `sscope import <file.json>` | Parse and validate a Google Benchmark JSON result file against the rules in `docs/BENCHMARK_SPEC.md` §9. Captures hardware and OS environment from the importing machine. Stores the result locally and marks it `user-supplied import`. No code in the JSON file is executed at any point during import, storage, or retrieval. |
| `sscope import <file.json> --commit <sha> --build-config <descriptor>` | Supply optional provenance metadata on import. Both flags are independently optional. The `--commit` flag stores the SHA verbatim as user-supplied metadata. |
| `sscope status` | Report agent version, registered device identity (if registered), backend connectivity status (reachable / unreachable), count of locally stored unsynced sessions, and local storage path. Works offline. |
| `sscope list` | List locally stored run records. Displays: run ID, benchmark source (`synthetic` / `user-supplied import`), benchmark name or suite, timestamp, Git SHA (if present). Supports `--source synthetic\|import`, `--limit N`, and `--format json`. Works offline against local SQLite. Run IDs produced here are accepted by `sscope compare`. |
| `sscope compare <run-id-a> <run-id-b>` | Request statistical regression analysis between two stored runs from the backend. Requires backend connectivity. If the backend is unreachable, exits with code 3 and an explicit message such as: `error: sscope compare requires a backend connection. Backend at <url> is unreachable.` No offline comparison against locally cached data is performed in MVP. |
| `sscope register --backend <url>` | One-time device registration. Prompts for the setup token using hidden input (no echo to terminal). Stores the returned API key in macOS Keychain. Registration protocol is specified in `docs/SECURITY.md` §5.2. **Pending CX-1:** this command must be added to `PROJECT.md` §5.1 before implementation. |

**Security constraint (verbatim, in effect for all MVP phases):**

> Importing a benchmark result MUST NOT execute any code contained in the input. File paths and executable names supplied through imported metadata MUST NEVER be interpreted as commands. The import pipeline is data parsing only.

### 4.2 Local Persistence (OQ-8 Resolved)

**Decision:** Embedded SQLite in WAL mode at `~/.config/sscope/local.db`.

**Rationale:** SQLite WAL mode provides atomic write guarantees across process crashes — a SIGKILL during a write does not leave a silently corrupt partial record. It also supports structured queries, which `sscope list --source` filtering requires. JSON files on disk provide neither atomic writes nor query capability without additional infrastructure.

Both `PRAGMA journal_mode=WAL` and `PRAGMA foreign_keys=ON` are set on every connection open. Schema is defined in §6.2.

### 4.3 Synchronization Behavior (OQ-9 Resolved)

**Trigger:** Automatic best-effort sync is attempted after every successful `sscope run` and `sscope import`. There is no background daemon and no polling process.

**Failure handling:** If sync fails, `sync_status` on the local session record remains `pending`. The next CLI command that successfully reaches the backend retries all `pending` sessions before completing its primary operation.

**Conflict handling:** Sync uses the canonical content fingerprint per session_id. The backend response determines the outcome:

| Response | Meaning | Agent action |
|---|---|---|
| 201 Created | New `session_id` accepted | `sync_status` = `synced` |
| 200 OK | Same `session_id`; fingerprint matches existing record | Identical retry; `sync_status` = `synced` |
| 409 Conflict | Same `session_id`; fingerprint does not match | `sync_status` = `conflict`; clear error surfaced to user |

The exact retry protocol and canonicalization algorithm are specified in §7 and `docs/API_CONTRACTS.md`.

### 4.4 Offline Behavior (OQ-9 Resolved)

| Command | Offline behavior |
|---|---|
| `sscope run` | Fully offline. Stores result locally. Exits 0 with a message noting local-only storage. |
| `sscope import` | Fully offline. Stores result locally. Exits 0 with a message noting local-only storage. |
| `sscope status` | Fully offline. Reports connectivity as "unreachable." Exits 0. |
| `sscope list` | Fully offline. Queries local SQLite directly. Exits 0. |
| `sscope compare` | **Requires backend connectivity.** Exits 3 with explicit error if backend is unreachable. |

### 4.5 Platform Adapter Interface

All OS-specific hardware discovery — CPU model, core counts, frequency, total memory, available memory, OS name, OS version — is implemented behind a platform adapter interface defined once in the core engine. No platform-specific API call appears outside an adapter implementation file. The macOS adapter uses `sysctl` and `IOKit`. The Linux adapter path is reserved for a future second implementation; adding it must not require changes to the core engine. See `REQUIREMENTS.md` FR-A-018 and NFR-006.

### 4.6 HTTP Client

**Decision:** libcurl for all agent-to-backend HTTP communication. Resolved via CMake `find_package(CURL REQUIRED)`.

TLS certificate validation must not be disabled in production builds: `CURLOPT_SSL_VERIFYPEER` and `CURLOPT_SSL_VERIFYHOST` must both be set to their enforcing values. The exact TLS configuration requirements are specified in `docs/SECURITY.md` §12.

---

## 5. Backend (Node.js / TypeScript / Express)

### 5.1 Startup Sequence

1. Load and validate environment variables. Fail fast on any missing required variable before opening any connections.
2. Read `SSCOPE_DASHBOARD_PASSWORD`; bcrypt-hash it in memory using cost ≥ 12; clear `process.env.SSCOPE_DASHBOARD_PASSWORD` immediately after hashing.
3. Open the PostgreSQL connection pool using the application account (`sscope_app`); execute a readiness probe (e.g., `SELECT 1`). Abort startup if the database is unreachable. The database must be confirmed ready before any secret material is printed to stdout.
4. Generate the one-time setup token (256-bit random, base64url); bcrypt-hash it; store only the hash in memory; print the plaintext token to stdout exactly once.
5. Register middleware (security headers, rate limiting, body limits, auth).
6. Register routes.
7. Begin serving.

**Migrations are not run at startup.** Running migrations at application startup would require DDL privileges on the application account, violating the minimum-privilege policy in `docs/SECURITY.md` §12.3. Migrations are a separate pre-deployment step using the `sscope_migrations` account (see §10).

### 5.2 Directory Layout (`backend/src/`)

```
routes/
  register.ts       # POST /api/v1/register
  runs.ts           # POST /api/v1/runs, GET /api/v1/runs, GET /api/v1/runs/:id
  comparisons.ts    # POST /api/v1/comparisons, GET /api/v1/comparisons/:id
  dashboard.ts      # POST /dashboard/login, POST /dashboard/logout
middleware/
  auth.ts           # API key verification; session cookie verification
  rateLimit.ts      # ON by default; opt-out via SSCOPE_DISABLE_RATE_LIMIT=true (§5.4)
  logger.ts         # Structured request logging (pino)
  securityHeaders.ts
db/
  pool.ts           # PostgreSQL connection pool; application account only; no SQLite
engine/
  comparison.ts     # Regression detection; MetricResult; guard clauses G1–G6
  explanation.ts    # Rule-based explanation builder
  statistics.ts     # Welch's t-test; Holm–Bonferroni correction (§8)
static/             # Built React SPA; dashboard/dist/ is copied here at build time
```

### 5.3 Route Authorization

The table below reflects the route authorization approved in this architecture. It differs from the current text of `docs/SECURITY.md` §5.3 in one respect: `POST /api/v1/comparisons` is not yet listed as accessible by dashboard session (CX-S-1 in §12). This difference is pending reconciliation. `docs/SECURITY.md` is the authoritative security specification. Implementation of `POST /api/v1/comparisons` must wait until `docs/SECURITY.md` §5.3 is updated to reflect this approved decision.

| Route | Agent API Key | Dashboard Session | Setup Token |
|---|---|---|---|
| `POST /api/v1/register` | **No** | **No** | Yes (only) |
| `POST /api/v1/runs` | Yes | **No** | No |
| `GET /api/v1/runs` | Yes | Yes | No |
| `GET /api/v1/runs/:id` | Yes | Yes | No |
| `POST /api/v1/comparisons` | Yes | Yes | No |
| `GET /api/v1/comparisons/:id` | Yes | Yes | No |
| `POST /dashboard/login` | No | No | No (password credential) |
| `POST /dashboard/logout` | No | Yes | No |

A dashboard session **never** authorizes `POST /api/v1/runs` or `POST /api/v1/register`. A request to any agent write endpoint bearing only a dashboard session cookie must be rejected with HTTP 403 Forbidden. A dashboard session must never grant agent write privileges or registration authorization under any condition.

`POST /api/v1/comparisons` is accessible by dashboard session. This was approved during the architecture consistency review. The current `docs/SECURITY.md` §5.3 does not list this; see §12, CX-S-1.

### 5.4 Rate Limiting

Rate limiting is **on by default**. Explicit opt-out: set `SSCOPE_DISABLE_RATE_LIMIT=true`. This opt-out is intended only for localhost-only or isolated LAN deployments.

For internet-accessible deployments: 100 req/min general; 10 req/min for write endpoints; 60 req/min for read endpoints. These limits are enforced by `middleware/rateLimit.ts` regardless of the request source. Per `docs/SECURITY.md` §11, limits must not be silently disabled based on the origin IP address.

---

## 6. Database Schemas

### 6.1 PostgreSQL Schema

All DDL is executed by the `sscope_migrations` account as a pre-deployment step, not at application startup. The application account (`sscope_app`) has no DDL privileges.

```sql
CREATE TABLE devices (
  device_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_name     TEXT NOT NULL,
  api_key_hash    TEXT NOT NULL,       -- bcrypt cost >= 12 per docs/SECURITY.md §5.1
  registered_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  -- session_id is a UUID v4 generated by the agent before local persistence.
  -- The same value is submitted to PostgreSQL on first sync and used for all
  -- subsequent idempotent sync lookups.
  session_id          UUID PRIMARY KEY,
  device_id           UUID NOT NULL REFERENCES devices(device_id),
  run_name            TEXT NOT NULL,   -- <= 1,024 bytes per CX-2 (pending BENCHMARK_SPEC.md)
  os_name             TEXT NOT NULL,
  os_version          TEXT NOT NULL,
  cpu_name            TEXT NOT NULL,
  isa                 TEXT NOT NULL,   -- e.g. "arm64", "x86_64"
  build_type          TEXT NOT NULL,   -- e.g. "Release", "Debug"
  source              TEXT NOT NULL
                          CHECK (source IN ('synthetic', 'user-supplied import')),
  source_marker       TEXT,            -- file path for imports; run invocation ref for synthetic
  git_sha             TEXT,            -- user-supplied via --commit; nullable
  build_config        TEXT,            -- user-supplied via --build-config on import; nullable
  import_timestamp    TIMESTAMPTZ NOT NULL DEFAULT now(),
  import_environment  JSONB,               -- null for synthetic sessions; hardware snapshot of importing machine (BD-2; see docs/API_CONTRACTS.md §4.3)
  -- content_fingerprint covers all immutable submission data (see §7).
  -- There is NO global UNIQUE constraint on this column. Fingerprint comparison
  -- is scoped to an existing session_id: same session_id + matching fingerprint = 200;
  -- same session_id + differing fingerprint = 409; new session_id = 201.
  content_fingerprint TEXT NOT NULL,
  submitted_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE benchmark_cases (
  case_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  project_name    TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,       -- byte-exact per BENCHMARK_SPEC.md §8.1; no normalization
  -- aggregate_name is per-row inside measurements JSONB, not a column (see docs/API_CONTRACTS.md §7)
  -- data_type values are the exact labels from BENCHMARK_SPEC.md §9.8.
  -- raw_samples_available: one or more raw rows stored for this canonical name.
  -- aggregate_only:        only aggregate rows; no raw rows stored.
  -- no_measurements:       canonical name referenced; no measurement rows present.
  -- Individual rows with run_type: unsupported are stored within the measurements
  -- blob with that tag and do not affect the group-level data_type value.
  data_type       TEXT NOT NULL
                      CHECK (data_type IN (
                        'raw_samples_available',
                        'aggregate_only',
                        'no_measurements'
                      )),
  measurements    JSONB NOT NULL,      -- exact schema defined in docs/API_CONTRACTS.md
  UNIQUE (session_id, project_name, canonical_name)
);

CREATE TABLE comparisons (
  comparison_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_a_id    UUID NOT NULL REFERENCES sessions(session_id),
  session_b_id    UUID NOT NULL REFERENCES sessions(session_id),
  result          JSONB NOT NULL,      -- full statistical result; schema in docs/API_CONTRACTS.md
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Provenance immutability trigger:**

The function and trigger below enforce that `source`, `source_marker`, and `import_timestamp` cannot be updated after insert. `docs/SECURITY.md` §13.2 defines the equivalent trigger referencing a table named `runs`; the correct table name is `sessions`. `docs/SECURITY.md` must be updated to match (see §12, CX-S-2). The provenance field names are unchanged.

```sql
CREATE OR REPLACE FUNCTION prevent_provenance_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.source IS DISTINCT FROM OLD.source OR
     NEW.source_marker IS DISTINCT FROM OLD.source_marker OR
     NEW.import_timestamp IS DISTINCT FROM OLD.import_timestamp THEN
    RAISE EXCEPTION
      'provenance fields (source, source_marker, import_timestamp) are immutable after insert';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_provenance_immutability
BEFORE UPDATE ON sessions
FOR EACH ROW EXECUTE FUNCTION prevent_provenance_update();
```

**Database account summary:**

| Account | Privileges | Used by |
|---|---|---|
| `sscope_migrations` | DDL (CREATE, ALTER, DROP) + DML on all tables | Pre-deployment migration step only |
| `sscope_app` | SELECT, INSERT on all tables; UPDATE (api_key_hash) on `devices`; no DDL | Backend application at runtime |

The column-level `UPDATE (api_key_hash) ON devices` grant is the minimum privilege required for atomic API-key replacement during device re-registration (`docs/SECURITY.md` §5.1). No other column on `devices` and no column on any other table requires UPDATE by the application account at runtime.

Execute the following grants as part of the pre-deployment migration step:

```sql
-- Executed by sscope_migrations during schema setup
GRANT SELECT, INSERT ON devices, sessions, benchmark_cases, comparisons TO sscope_app;
GRANT UPDATE (api_key_hash) ON devices TO sscope_app;
```

### 6.2 SQLite Schema (Agent-Exclusive)

This database is created and owned by the local C++ agent. No other component reads or writes it.

```sql
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE sessions (
  -- UUID v4 generated by the agent before local persistence.
  -- This exact value is submitted as session_id to PostgreSQL on sync.
  session_id          TEXT PRIMARY KEY,
  run_name            TEXT NOT NULL,
  os_name             TEXT NOT NULL,
  os_version          TEXT NOT NULL,
  cpu_name            TEXT NOT NULL,
  isa                 TEXT NOT NULL,
  build_type          TEXT NOT NULL,
  source              TEXT NOT NULL
                          CHECK (source IN ('synthetic', 'user-supplied import')),
  source_marker       TEXT,
  git_sha             TEXT,
  build_config        TEXT,
  import_timestamp    TEXT NOT NULL,           -- ISO 8601
  import_environment  TEXT,                    -- null for synthetic; JSON snapshot of importing machine hardware (BD-2)
  content_fingerprint TEXT NOT NULL,
  sync_status         TEXT NOT NULL DEFAULT 'pending'
                          CHECK (sync_status IN ('pending', 'synced', 'conflict')),
  sync_reason         TEXT,                    -- populated when sync_status remains 'pending' for a known reason, e.g. 'body_limit_exceeded'
  submitted_at        TEXT NOT NULL            -- ISO 8601
);

CREATE TABLE benchmark_cases (
  case_id         TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL REFERENCES sessions(session_id),
  project_name    TEXT NOT NULL,
  canonical_name  TEXT NOT NULL,
  data_type       TEXT NOT NULL
                      CHECK (data_type IN (
                        'raw_samples_available',
                        'aggregate_only',
                        'no_measurements'
                      )),
  measurements    TEXT NOT NULL,               -- JSON blob; exact schema in docs/API_CONTRACTS.md
  UNIQUE (session_id, project_name, canonical_name)
);
```

---

## 7. Idempotent Synchronization

**session_id generation:** The agent generates a UUID v4 for each session before writing to local SQLite. This value is the primary key in both the local SQLite `sessions` table and the PostgreSQL `sessions` table. It is never regenerated on retry.

**Canonical content fingerprint:** The fingerprint covers all immutable submission data for a session:

- Session-level fields: `run_name`, `os_name`, `os_version`, `cpu_name`, `isa`, `build_type`, `source`, `source_marker`, `import_timestamp`, `git_sha`, `build_config`.
- Per-case fields (all cases, in a canonical order): `(project_name, canonical_name, data_type, measurements)`.

The fingerprint is computed before local persistence and does not change after the session is created. Provenance fields are included because they are immutable by definition.

**Sync protocol:**

| Backend response | Condition | Agent action |
|---|---|---|
| 201 Created | `session_id` not previously seen by backend | Session accepted as new submission; `sync_status` = `synced` |
| 200 OK | Same `session_id`; submitted fingerprint matches stored fingerprint | Identical retry; backend returns existing session record; `sync_status` = `synced` |
| 409 Conflict | Same `session_id`; submitted fingerprint does not match stored fingerprint | Conflicting payload for this session; `sync_status` = `conflict`; surface clear error to user identifying the session_id |

There is no global `UNIQUE` constraint on `content_fingerprint` in PostgreSQL. Two distinct sessions (different `session_id` values) may legitimately produce the same measurements — for example, re-running the same benchmark suite on the same machine. Each is a separate, independently submitted session.

**API_CONTRACTS.md prerequisite:** The exact canonicalization algorithm — field ordering, serialization format (e.g., canonical JSON), and hash function — is deferred to `docs/API_CONTRACTS.md`. This is a hard implementation blocker (B-1 in §13). Neither the agent sync path nor the backend `POST /api/v1/runs` handler can be implemented without it.

---

## 8. Statistical Engine

The backend statistical engine implements the methodology specified in `docs/BENCHMARK_SPEC.md` §6. This document does not restate those rules; `docs/BENCHMARK_SPEC.md` is authoritative. Key implementation references:

| Topic | BENCHMARK_SPEC.md Section |
|---|---|
| Four classification labels (C1–C5) | §6.6 |
| Guard clauses (G1–G6) | §6.2 |
| Constant-samples path | §6.3 |
| Welch's t-test | §6.4 |
| Holm–Bonferroni correction; M_p definition | §6.5 |
| Overall summary generation; K1–K4, M definition | §6.9 |
| CI gate eligibility; M_c definition | §6.10 |
| Data type labels | §9.8 |
| Aggregate-only (Tier C) descriptive path | §9.9 |
| Blocking conditions: ISA, OS family, Debug vs. non-Debug | §7.1 |
| Confounding flags and severity | §7.2 |

The engine operates exclusively on data stored in `benchmark_cases.measurements`. It does not execute any code submitted in benchmark data. All classification output is deterministic for the same inputs.

---

## 9. Web Dashboard

React 18 SPA built with Vite. The `dashboard/dist/` build output is copied into `backend/src/static/` and served by Express at the same origin as the API. No separate server is required; no CORS configuration is needed.

The SPA sends all API requests using the session cookie (Path=`/`, HttpOnly, SameSite=Strict, Secure, Max-Age=86400 per `docs/SECURITY.md` §5.5). The cookie must be included on all requests to `/api/v1/*`.

The dashboard may initiate comparisons via `POST /api/v1/comparisons` (authorized by dashboard session per §5.3). The dashboard must never submit benchmark measurements (`POST /api/v1/runs`) or register devices (`POST /api/v1/register`).

---

## 10. Local Development Environment (OQ-6 Resolved)

**Local development:** A Docker Compose file at the repository root provides a local PostgreSQL 16 instance for development. The backend connects via TCP bound to `127.0.0.1`. This requires a narrowly scoped amendment to `docs/SECURITY.md` §12.1 permitting `sslmode=disable` for this connection configuration only — see §12, CX-S-3. The Docker Compose configuration and `.env.example` must not be committed until that amendment is authorized and written.

**Production / hosted deployment:** The backend connects to a remote PostgreSQL instance using `sslmode=verify-full`. The agent connects to the hosted backend over HTTPS with TLS certificate validation enforced.

**Migration workflow:** Before starting the backend for the first time or after a schema change:

```sh
# Step 1 — Provision cluster-level roles (requires PostgreSQL superuser; safe to rerun):
psql sscope -f backend/migrations/000_create_roles.sql

# Step 2 — Apply schema and security migrations (in order):
psql sscope -f backend/migrations/001_initial_schema.sql
psql sscope -f backend/migrations/002_protect_content_fingerprint.sql
```

Each migration file is idempotent where possible. `000_create_roles.sql` creates the `sscope_migrations` and `sscope_app` roles only if they do not already exist (cluster-level `IF NOT EXISTS` guards). The backend startup sequence never runs migrations.

**Backend environment variables:**

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string for the application account: `postgres://sscope_app:<password>@<host>:<port>/<dbname>` |
| `SSCOPE_DASHBOARD_PASSWORD` | Yes | bcrypt hash (cost ≥ 12) of the dashboard login password; cleared from `process.env` at startup |
| `PORT` | No | TCP port the backend listens on (default: 3000) |
| `SSCOPE_DISABLE_RATE_LIMIT` | No | Set to `true` to disable rate limiting; localhost-only deployments only |

---

## 11. Build and Distribution (OQ-4 Partial)

**Agent — build from source (MVP):**

```sh
cmake -S agent -B agent/build -DCMAKE_BUILD_TYPE=Release
cmake --build agent/build
```

Minimum macOS 13.0 (Ventura) per `docs/BENCHMARK_SPEC.md` §3.1. The CMake build locates libcurl via `find_package(CURL REQUIRED)`.

**Homebrew formula:** Deferred post-MVP. Build from source is the MVP installation method.

**Backend:**

```sh
npm install --prefix backend
npm run build --prefix backend
npm start --prefix backend
```

**Dashboard — build and integrate:**

```sh
npm install --prefix dashboard
npm run build --prefix dashboard        # outputs to dashboard/dist/
cp -r dashboard/dist/. backend/src/static/
```

The dashboard build step must run before the backend is started; the backend serves the files from `backend/src/static/` at startup.

---

## 12. Cross-Document Changes Required

The following corrections are pending. None of these modify any file — each requires explicit authorization before the target document is edited.

| ID | Document | Section | Correction Required |
|---|---|---|---|
| CX-1 | `PROJECT.md` | §5.1 | Add `sscope register --backend <url>` to the CLI command list. Description: one-time device registration; prompts for setup token via hidden input; stores the returned API key in macOS Keychain. Full registration protocol in `docs/SECURITY.md` §5.2. |
| CX-2 | `docs/BENCHMARK_SPEC.md` | §9.3 | Add `run_name ≤ 1,024 bytes` and `aggregate_name ≤ 64 bytes` field-length constraints. Required to confirm the provisional 25 MiB run submission body limit in `docs/SECURITY.md` §9.2. |
| CX-3 | `REQUIREMENTS.md` | FR-D | Add a dashboard authentication requirement. The dashboard is authenticated via password and session cookie as specified in `docs/SECURITY.md` §5.4–§5.5. |
| CX-4 | `REQUIREMENTS.md` | SEC-001, FR-B-003 | Clarify that no backend-to-agent remote execution channel exists in MVP. FR-B-003 must be revised: the backend does not trigger operations on the agent in the MVP architecture. |
| CX-4b | `PROJECT.md` | §5.3 | Update "Remote-triggered operations are restricted to a predefined, validated set of synthetic benchmark operations" to clarify this is a future architectural constraint, not an MVP capability. |
| CX-5 | `docs/API_CONTRACTS.md` | (to be written) | Define 25 MiB body limit, 10,000 benchmark record limit, and provenance fields when writing this document. |
| CX-6 | `docs/API_CONTRACTS.md` | (to be written) | Define `POST /api/v1/register` schema, HTTP 409 semantics, and one-time-use token semantics when writing this document. |
| CX-S-1 | `docs/SECURITY.md` | §5.3 | **Applied in implementation** (2026-11-05): `POST /api/v1/comparisons` accepts dashboard session authentication in `backend/src/routes/comparisons.ts`. Update to `docs/SECURITY.md §5.3` deferred post-MVP. |
| CX-S-2 | `docs/SECURITY.md` | §13.2 | **Applied in migration** (2026-11-05): `001_initial_schema.sql` and `002_protect_content_fingerprint.sql` correctly reference table `sessions`. Update to `docs/SECURITY.md §13.2` deferred post-MVP. |
| CX-S-3 | `docs/SECURITY.md` | §12.1 | Add a narrowly scoped row permitting `sslmode=disable` for Docker Compose / containerized local development with TCP bound to `127.0.0.1` only. Remote and hosted deployments retain `sslmode=verify-full`. Without this amendment, the Docker Compose configuration contradicts the security specification. |

**Applied in this document revision:** BD-2 (`import_environment` column added to PostgreSQL §6.1 and SQLite §6.2 `sessions` tables; null for synthetic sessions). CX-ARCH-1: `sync_reason TEXT` column added to SQLite §6.2 `sessions` table. CX-ARCH-2: `aggregate_name` case-level column removed from both `benchmark_cases` tables; field now lives per-row inside the `measurements` JSONB (see `docs/API_CONTRACTS.md` §7). CX-S-1: `POST /api/v1/comparisons` dashboard session authorization applied in implementation (2026-11-05). CX-S-2: Provenance immutability trigger correctly targets `sessions` table in migrations (2026-11-05).

---

## 13. Implementation Prerequisites

No implementation work that depends on a listed prerequisite may begin until that prerequisite is resolved in the designated document.

| ID | Prerequisite | What it blocks | Resolve in |
|---|---|---|---|
| B-1 | Canonical content fingerprint algorithm: exact field ordering, serialization format, and hash function | Agent sync path; backend `POST /api/v1/runs` fingerprint verification logic | `docs/API_CONTRACTS.md` |
| B-2 | API versioning strategy (OQ-5): version negotiation mechanism, URL prefix vs. header, backward-compatibility guarantees | All backend route implementation | `docs/API_CONTRACTS.md` |
| B-3 | CX-2: `run_name ≤ 1,024 bytes` and `aggregate_name ≤ 64 bytes` added to `docs/BENCHMARK_SPEC.md` | Confirmation of the provisional 25 MiB body limit in `docs/SECURITY.md` §9.2 | `docs/BENCHMARK_SPEC.md` |
| B-4 | CX-S-1: `docs/SECURITY.md` §5.3 updated to list `POST /api/v1/comparisons` as dashboard-session-accessible | Implementation of `backend/src/routes/comparisons.ts` authorization check | `docs/SECURITY.md` |
| B-5 | CX-S-3: `docs/SECURITY.md` §12.1 Docker Compose TLS amendment authorized and written | `docker-compose.yml` and `.env.example` | `docs/SECURITY.md` |

**B-1 and B-2** must be resolved by writing `docs/API_CONTRACTS.md` before any backend route or agent sync code can be written.

**B-3 through B-5** must be resolved before those specific files or configuration can be finalized, but do not block unrelated implementation work.

---

_This document records approved architectural decisions as of 2026-11-01. Changes to decisions recorded here require explicit approval and must be reflected in this document before implementation proceeds._
