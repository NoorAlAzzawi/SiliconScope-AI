# SiliconScope-AI Security Specification

**Version:** 0.1 (MVP)
**Status:** Draft — pending cross-document change approvals (CX-1 through CX-6)

---

## 1. Purpose and Scope

This document specifies the security architecture for the SiliconScope-AI MVP. It covers:

- Threat model and trust boundaries
- Authentication and authorization
- TLS configuration
- Agent security model
- Google Benchmark JSON import security
- Backend input validation and resource limits
- CLI and local storage security
- Backend API and dashboard security
- PostgreSQL transport and access security
- Provenance field immutability
- Logging and error handling
- Security test cases
- MVP-essential vs. deferred hardening
- Cross-document changes required

This specification applies to all three deployment configurations: localhost-only developer, hosted single-user, and developer laptop with remote backend.

---

## 2. Open Questions Resolved

**OQ-1 (Authentication mechanism):** Resolved with a three-credential architecture:

| Principal | Credential | Storage (client) | Storage (server) |
|---|---|---|---|
| Agent (per device) | 256-bit random API key | macOS Keychain | bcrypt hash in PostgreSQL |
| Registration bootstrap | One-time setup token | Not stored | Invalidated on first use |
| Dashboard user | Password (SSCOPE_DASHBOARD_PASSWORD) | Not stored | bcrypt hash in memory at startup |

---

## 3. Threat Model

### 3.1 In-Scope Threats

| ID | Threat | Relevant sections |
|---|---|---|
| T1 | Malicious or malformed Google Benchmark JSON (code injection, resource exhaustion, path traversal) | §8 |
| T2 | Unauthorized API access (unauthenticated run submissions, data reads) | §5, §11 |
| T3 | Secret leakage via shell history, process lists, log files | §5.2, §14 |
| T4 | Local file system disclosure (stored API keys, database credentials) | §10 |
| T5 | Database access via compromised app credentials | §12 |
| T6 | Provenance tampering (retroactive mutation of source, marker, timestamp) | §13 |
| T7 | XSS via imported benchmark strings rendered in dashboard | §11.4 |
| T8 | Session fixation or hijacking on dashboard | §5.3 |
| T9 | Resource exhaustion via oversized or deeply nested payloads | §8, §9 |

### 3.2 Out-of-Scope for MVP

- Multi-tenant isolation (single-user tool)
- DDoS beyond basic rate limiting
- Supply-chain compromise of dependencies
- Hardware side-channel attacks
- Credential phishing

---

## 4. Trust Boundaries

| ID | Boundary | Crossing it requires |
|---|---|---|
| TB1 | Local filesystem → agent process | OS user permissions |
| TB2 | Agent process → backend API | Valid API key (per-device) |
| TB3 | Browser → backend (dashboard) | Session cookie (password-authenticated) |
| TB4 | Backend process → PostgreSQL | DB credentials; sslmode=verify-full for remote |

The backend process is the sole trust anchor for all writes to PostgreSQL. No client (agent or browser) writes to the database directly.

---

## 5. Authentication and Authorization

### 5.1 Agent API Key

**Generation:** 256 bits of cryptographically random data, base64url-encoded (no padding), producing a 43-character string. Generated server-side at device registration.

**Server-side storage:** bcrypt hash (cost factor >= 12) stored in the `devices` table. The plaintext key is never persisted.

**Client-side storage:** macOS Keychain via `security add-generic-password`. Keychain service name: `sscope-api-key`. Access limited to the `sscope` binary.

**Transmission:** `Authorization: Bearer <key>` header on all agent API requests. TLS required in production (see §6).

**Key revocation on re-registration:** When a device re-registers (either to recover from an interrupted registration or to rotate credentials intentionally), the existing active key for that `device_id` is atomically revoked and a new key is issued in a single database transaction. The previous key is not retained as a secondary active credential; only one active key per `device_id` exists at any time. See §5.2 for the complete re-registration and recovery policy. MVP provides no automatic rotation.

**Threat addressed:** T2 — prevents unauthenticated run submissions.

### 5.2 Device Registration Bootstrap

The initial registration mechanism prevents unauthorized devices from issuing themselves API keys.

**Setup token generation:** At backend startup, one 256-bit cryptographically random token is generated and printed once to stdout:

```
SiliconScope registration token: <token>
Keep this safe — it is shown only once and expires after first use.
```

The token is stored in memory only (as a bcrypt hash). It is NOT written to any persistent log file or database.

**Terminal detection:** If the backend's stdout is not a terminal (`isatty()` returns false), the backend emits a warning to stderr before printing the token:

```
WARNING: setup token is being written to a non-terminal (stdout is redirected).
Treat any log file or journal entry containing this output as a secret.
```

This warning is informational only. It does not prevent the token from appearing in captured output, a redirected log file, or a service-manager journal. The operator is solely responsible for controlling access to wherever startup stdout is written.

**Hosted deployment (systemd and service managers).** When the backend runs as a `systemd` service, stdout is captured by `journald` by default. The token appears in the system journal alongside ordinary log output. `isatty()` returns false for journald-captured output, so the warning fires — but into the same journal as the token itself.

Operator guidance for systemd deployments:

- **Required for hosted deployments:** Redirect startup stdout to an access-restricted file before starting the service. In the systemd unit file, set `StandardOutput=file:/var/lib/sscope/startup.log` with `startup.log` owned by the service user and mode `0600`. The token is readable only by the service user and the operator. After retrieving and using the token, truncate or delete the file so the secret does not persist at rest.
- **Avoid relying on the system journal as the retrieval path.** `journald` is not a controlled-access secret store. If the token lands in the journal (because `StandardOutput` was not redirected), restrict journal read access immediately and treat the journal entries for that startup as sensitive material. Do not leave the token in the journal indefinitely.
- The backend's structured JSON log stream used by log aggregators does NOT contain the token (see §14.3). Only the startup stdout stream does.

**CLI registration flow:**

```
sscope register --backend https://example.com
```

The CLI prompts with hidden input (equivalent to `read -s`):

```
Registration token: [hidden]
```

The `--token` flag does NOT exist. Passing the token as a CLI argument is not supported, preventing exposure in shell history and `/proc/<pid>/cmdline`.

**Registration request:**

```
POST /api/v1/register
Content-Type: application/json

{
  "device_id":   "<uuid-v4>",
  "device_name": "<hostname>",
  "setup_token": "<plaintext token>"
}
```

Token verification and invalidation must execute as a single atomic operation under a mutual-exclusion guard protecting the in-memory token state:

```
1. Acquire the registration mutex.
2. If the token is already marked invalidated: release mutex, return HTTP 409 Conflict.
3. Verify the submitted token with bcrypt.CompareHashAndPassword against the stored hash.
4. If verification fails: release mutex, return HTTP 401 Unauthorized.
5. Mark the token as permanently invalidated in memory.
6. Release the mutex.
7. Attempt to write the new device record (device_id, device_name, api_key_hash) to the database.
8. If the database write fails: return HTTP 500. The token is already invalidated; the device is not registered.
9. If the database write succeeds: return the plaintext API key to the client.
```

Invalidation (step 5) occurs inside the mutex and before the database write. This means two simultaneous requests carrying the same valid token cannot both succeed: the first acquires the mutex and marks the token invalidated; the second finds the token already invalidated and receives HTTP 409. A database failure in step 7 leaves the token permanently consumed and the device unregistered. Recovery requires a backend restart to generate a new token.

This approach accepts that a database failure during registration is unrecoverable without operator intervention. For a single-user MVP this is acceptable — the cost of a restart is low and the security property (one registration per token, no orphaned active credentials) is preserved.

**One-time use:** The token is consumed — permanently invalidated in memory at step 5 of the atomic protocol above — when a valid registration attempt is accepted, before the database write. If the database write subsequently fails, the token remains consumed; the device is not registered. Recovery requires a backend restart to generate a new token. If more than one device must be registered, the operator also restarts the backend to generate a new token.

**Registered API keys survive restart.** The setup token is in-memory only and is discarded on backend restart. API key hashes for already-registered devices are stored in the `devices` table in PostgreSQL and survive restarts. Existing registered agents do not need to re-register after a backend restart.

**Interrupted registration and re-registration policy.** If the backend consumed the setup token (invalidating it) but the network dropped before the client received the API key response, the operator is left with no usable key and no valid token. Recovery requires restarting the backend to generate a new token and re-running `sscope register`.

When `sscope register` is called for a `device_id` that already has an active key row in the `devices` table (whether from an interrupted prior attempt or an intentional rotation), the following policy applies:

- The backend atomically revokes the existing active key for that `device_id` and issues a new one in a single transaction. No interval exists during which both keys are simultaneously active.
- The old key is invalidated before the new key is returned to the client. Any in-flight request using the old key that arrives after the transaction commits will receive HTTP 401.
- A new valid setup token is required to authorize any re-registration. This is the same authorization requirement as initial registration — the setup token acts as the operator's proof of intent for both initial registration and recovery.

**Distinguishing interrupted registration from intentional rotation.** From the server's perspective, both cases are handled by the same re-registration flow: a request to `POST /api/v1/register` with a valid setup token and an existing `device_id`. The distinction is operational, not technical. A `reason` field may optionally be included in the registration request body (`"recovery"` or `"rotation"`) for audit logging purposes; it does not affect the server's behavior.

**Open design question (OD-SEC-1).** The re-registration policy above requires the operator to restart the backend to obtain a new setup token even for intentional key rotation. For a single registered device this is acceptable in MVP. If in future a dedicated key-rotation endpoint is introduced (not requiring a setup token), it must require the current active API key as proof of possession — preventing an attacker who does not hold the key from rotating it. This endpoint is deferred; it is not implemented in MVP.

**Threat addressed:** T3 (token not in shell history), T2 (unauthorized registration prevented).

### 5.3 Dashboard Authentication

The dashboard uses a separate password, independent of agent API keys.

**Configuration:** Set `SSCOPE_DASHBOARD_PASSWORD` environment variable before starting the backend. At startup, the backend bcrypt-hashes the value and clears it from the process environment. If the variable is not set, the dashboard endpoint returns HTTP 503.

**Login flow:**

```
POST /dashboard/login
Content-Type: application/x-www-form-urlencoded

password=<plaintext>
```

The backend compares against the stored bcrypt hash. On success, it issues a session cookie via `Set-Cookie` response header. The browser does not create this cookie — it is server-issued.

**Session cookie attributes:**

| Attribute | Value | Reason |
|---|---|---|
| HttpOnly | true | Inaccessible to JavaScript; mitigates XSS token theft |
| SameSite | Strict | Mitigates CSRF |
| Secure | true (HTTPS only) | Prevents transmission over plaintext HTTP |
| Path | / | Sent to all same-origin requests, including `/api/v1` routes called by the dashboard SPA |
| Max-Age | 86400 (24 hours) | Bounded session lifetime |

In localhost-only development, `Secure` may be omitted. In any hosted deployment, `Secure` is required.

**Session invalidation:** The backend maintains a server-side session store. Logout invalidates the session server-side. Sessions are not purely stateless JWT tokens.

**Authentication and authorization separation.** Setting `Path=/` means the session cookie accompanies all same-origin requests, including `/api/v1` routes. The backend must enforce strict authorization by credential type at the route level:

- `POST /api/v1/register`: authenticated by the one-time setup token only (supplied in the request body per §5.2). The registering device has no API key yet; the API key is returned only after successful registration. Neither a dashboard session cookie nor an existing agent API key authorizes this endpoint.
- `POST /api/v1/runs` and all other agent write endpoints: authenticated by agent API key (`Authorization: Bearer <key>`) only. A dashboard session cookie must not authorize these endpoints.
- Dashboard session cookie: authorizes read-only retrieval, comparison requests, and comparison retrieval — specifically `GET /api/v1/runs`, `GET /api/v1/runs/:id`, `POST /api/v1/comparisons`, and `GET /api/v1/comparisons/:id`. It must not authorize any registration or agent write endpoint. **(CX-S-1 — 2026-11-02: `POST /api/v1/comparisons` explicitly added to dashboard-session-authorized routes, consistent with `ARCHITECTURE.md §5.3`.)**
- A request to a write or registration endpoint bearing only a dashboard session cookie must be rejected with HTTP 403 Forbidden. A dashboard session must never grant agent write privileges or registration authorization under any condition.

Route-level middleware must enforce the required credential type independently for each endpoint class. A single combined "is authenticated" check is not sufficient.

**No shared credentials:** The dashboard password and agent API key are completely separate. Compromising one does not compromise the other.

**Threat addressed:** T2 (unauthorized dashboard access), T8 (session fixation — server issues new session ID on successful login).

### 5.4 Authorization

MVP is single-user. There is no role-based access control. Every authenticated agent has equal write access; the authenticated dashboard user has full read access. No per-resource authorization checks beyond authentication are implemented in MVP.

---

## 6. TLS Configuration

**Minimum version:** TLS 1.2. TLS 1.0 and 1.1 are disabled.

**Cipher suites:** Delegate to the language runtime's secure defaults. No manual cipher suite pinning in MVP.

**Certificate pinning:** Not implemented in MVP. The agent validates the server certificate against the system trust store (standard TLS verification).

**Self-signed certificates:** Supported for localhost development only. The agent provides a `--ca-cert` flag to specify a custom CA for local development. In production, a CA-signed certificate is required.

**HSTS:** When serving over HTTPS, the backend includes `Strict-Transport-Security: max-age=31536000` in all responses.

---

## 7. Agent Security Model

### 7.1 No Remote Execution Channel in MVP

The backend NEVER sends executable commands, scripts, or shell strings to any agent. All six agent use cases defined in PROJECT.md and REQUIREMENTS.md are agent-initiated:

1. Agent submits a run result
2. Agent requests a comparison
3. Agent fetches its device configuration
4. Agent registers itself
5. Agent checks backend health
6. Agent imports a local benchmark file

No MVP use case requires the backend to trigger execution on the agent machine.

**Security constraint (verbatim):**
> "The remote local agent must NEVER accept arbitrary shell commands, arbitrary executable paths, or untrusted scripts from the server."

**Forward-looking allowlist constraint:** If remote job triggering is added in a future version, the agent MUST maintain an explicit allowlist of permitted operation types. The backend may only request operations on that allowlist; the agent ignores all others. This constraint is architectural and applies to any future implementation.

### 7.2 Import Pipeline Constraint

**Security constraint (verbatim):**
> "Importing a benchmark result MUST NOT execute any code contained in the input. File paths and executable names supplied through imported metadata MUST NEVER be interpreted as commands. The import pipeline is data parsing only."

---

## 8. Google Benchmark JSON Import Security

### 8.1 No-Execution Guarantee

The JSON import pipeline is data parsing only. The following operations are explicitly prohibited during import:

- `eval()` or equivalent dynamic code execution
- Shell command execution (`exec`, `popen`, `subprocess`, etc.)
- Dynamic library loading based on field values
- File I/O based on paths extracted from JSON fields
- Template expansion that executes imported strings

All benchmark field values (name, run_name, aggregate_name, custom fields) are treated as opaque strings. They are stored as data and, when rendered in the dashboard, are escaped before insertion into the DOM (see §11.4).

### 8.2 In-Process Resource Limits

Limits are enforced during parsing, not post-parse. The parser must abort and return an error when a limit is exceeded. Operating-system process termination (OOM kill) is not an acceptable memory-safety strategy.

| Limit | Value | Enforcement point |
|---|---|---|
| Benchmark record count (items in the `benchmarks` array) | 10,000 | During parsing, increment a counter for each object entered inside the `benchmarks` array; abort on exceedance |
| JSON nesting depth | 32 | During parsing, increment depth counter on `{` or `[`; abort on exceedance |
| File size (pre-read check) | 50 MiB | stat() before opening file |
| File size (during read) | 50 MiB | Byte counter during streaming read; abort if exceeded |

Both the pre-read stat() check and the during-read byte counter are required. The stat() check is a fast-path guard; the byte counter defends against TOCTOU (the file may grow between stat() and read()).

### 8.3 TOCTOU Defense

```
1. stat() the file path — reject if size > 50 MiB
2. open() the file
3. Stream-read with a byte counter — abort if cumulative bytes > 50 MiB
4. Pass the bounded byte stream to the JSON parser
```

Steps 1 and 3 are both required. Step 1 alone is insufficient.

### 8.4 Rejection Behavior

When any limit is exceeded, the import pipeline:

1. Returns a structured error to the caller (not a crash or OOM)
2. Discards all partially parsed data
3. Does not write any partial result to the database
4. Logs the rejection with file size or depth/count at point of failure (not the file contents)

---

## 9. Backend Input Validation and Resource Limits

### 9.1 General Validation Principles

- Validate at system boundaries (user input, imported files, API request bodies)
- Reject unknown fields in API request bodies (strict schema validation)
- All string fields have explicit maximum lengths enforced at the API layer
- Numeric fields have explicit range checks (no negative counts, no NaN/Inf in statistical inputs)

### 9.2 Run Submission Body Limit

The maximum serialized body size for `POST /api/v1/runs` is **25 MiB**.

**Derivation:**

| Component | Calculation | Size |
|---|---|---|
| Max rows per submission | 10,000 (benchmark record limit, §8.2) | — |
| Per-row max bytes | name (1,024) + run_name (1,024) + aggregate_name (64) + numeric fields (100) + enum fields (20) + JSON overhead (100) | ~2,332 bytes |
| Subtotal | 10,000 × 2,332 | ~22.3 MiB |
| Metadata overhead | device_id, timestamps, build config | ~100 KB |
| Total upper bound | | ~22.4 MiB |
| Proposed limit | ~11% margin above upper bound | **25 MiB** |

**This limit is provisional.** The derivation above assumes `run_name` ≤ 1,024 bytes and `aggregate_name` ≤ 64 bytes per row. Neither limit is currently specified in `docs/BENCHMARK_SPEC.md` — only the `name` field has an explicit 1,024-byte limit (BENCHMARK_SPEC.md §9.3). Until `run_name` and `aggregate_name` byte-length constraints are added to BENCHMARK_SPEC.md (see CX-2), the 25 MiB figure cannot be treated as a guaranteed upper bound. If those constraints differ from the values used here, this limit must be recalculated.

**All other endpoints:** 1 MiB body limit.

### 9.3 Rate Limiting

| Deployment | Data submission endpoints | Comparison endpoints | Other endpoints |
|---|---|---|---|
| Internet-accessible | 100 req/min per device | 10 req/min per device | 60 req/min per device |
| Localhost-only | Optional | Optional | Optional |

Rate limiting is required for any deployment accessible from the public internet. The default configuration must be restrictive (i.e., limits are enabled by default and require explicit opt-out for localhost-only).

Exceeding a rate limit returns HTTP 429 with a `Retry-After` header.

### 9.4 Path Traversal Prevention

File paths provided in API requests or import metadata are never used to open files on the backend filesystem. The backend does not expose a generic file-read endpoint. Imported file paths are stored as metadata strings only.

---

## 10. CLI and Local Storage Security

### 10.1 API Key Storage

The agent API key is stored in the macOS Keychain, not in a plaintext configuration file. The Keychain entry attributes:

```
Service:  sscope-api-key
Account:  <device_id>
Access:   sscope binary only (ACL-restricted)
```

On macOS (the MVP platform), the API key is always stored in the macOS Keychain. The CLI does not fall back to a plaintext file. `SSCOPE_API_KEY` environment-variable support for Linux and headless CI environments is deferred with Linux platform support and is not an MVP requirement (see §16.3).

### 10.2 Configuration Directory

The `~/.config/sscope/` directory is created with mode `0700`. Configuration files within it are created with mode `0600`. The CLI refuses to start if it detects `~/.config/sscope/` is world-readable.

### 10.3 No Elevated Privileges

The `sscope` agent binary requires no elevated privileges (no `setuid`, no `sudo`). The agent does not install system services or modify system configuration in MVP.

---

## 11. Backend API and Dashboard Security

### 11.1 Same-Origin Architecture

The backend serves the React dashboard SPA as static files at the same origin as the API. This eliminates cross-origin requests between the dashboard and the API. CORS is not required for the dashboard-to-API path.

If a separate static file server is used, CORS headers must be configured explicitly to allow only the known dashboard origin. The API does not use wildcard `Access-Control-Allow-Origin: *`.

### 11.2 Security Response Headers

The backend includes the following headers on all responses:

| Header | Value |
|---|---|
| X-Content-Type-Options | nosniff |
| X-Frame-Options | DENY |
| Content-Security-Policy | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'` |
| Strict-Transport-Security | `max-age=31536000` (HTTPS deployments only) |

### 11.3 Error Responses

In production, API error responses do not include stack traces, internal file paths, SQL query text, or database error details. Error responses return a structured JSON body with an error code and a human-readable message.

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Field 'name' exceeds maximum length of 1024 characters"
  }
}
```

Stack traces are logged server-side (see §14) but never returned to the client.

### 11.4 XSS Prevention in Dashboard

All benchmark strings rendered in the dashboard (name, run_name, aggregate_name, custom field values) are treated as data, not markup. Specifically:

- `dangerouslySetInnerHTML` is NEVER used on any string sourced from imported benchmark data
- All imported strings are rendered via React's default text node mechanism (which escapes HTML entities automatically)
- No `eval()`, `Function()`, or `setTimeout(string)` calls on imported strings
- No inline event handlers (`onclick`, etc.) populated from imported data

**Threat addressed:** T7 — prevents stored XSS via imported benchmark names.

---

## 12. PostgreSQL Security

### 12.1 Transport Configuration

| Context | Connection method | sslmode | Notes |
|---|---|---|---|
| Local development (preferred) | Unix socket | N/A (no TCP) | No network exposure |
| Local development (TCP) | TCP localhost | `require` | Encrypts; does NOT verify server cert |
| Docker Compose (local dev only) | TCP, Docker bridge network | `disable` | **Permitted exception (CX-S-3 / B-5 — 2026-11-02):** Docker Compose internal networking does not support TLS between service containers on the same bridge network. `sslmode=disable` is permitted here because the PostgreSQL port is never exposed outside the Docker bridge (`expose:`, not `ports:`), and the connection is effectively localhost-equivalent. This exception applies **only** to Docker Compose local development. Any TCP connection that crosses a network boundary (including a remote host or any deployment outside the Docker Compose bridge) requires `sslmode=verify-full`. |
| Remote production | TCP | `verify-full` | Encrypts + CA verification + hostname check |

**`sslmode` distinctions:**

| Mode | Encrypted | Verifies CA | Verifies hostname | MITM protection |
|---|---|---|---|---|
| `disable` | No | No | No | None |
| `require` | Yes | No | No | No (MITM possible) |
| `verify-ca` | Yes | Yes | No | Partial |
| `verify-full` | Yes | Yes | Yes | Full |

`sslmode=require` is not sufficient for remote production deployments because it does not verify the server's identity. `sslmode=verify-full` is required for any remote database connection.

### 12.2 Credentials

Database credentials are supplied via environment variables:

```
SSCOPE_DB_HOST
SSCOPE_DB_PORT
SSCOPE_DB_NAME
SSCOPE_DB_USER
SSCOPE_DB_PASSWORD
SSCOPE_DB_SSLMODE
SSCOPE_DB_SSLROOTCERT  (required when sslmode=verify-full)
```

These variables are never logged or included in error responses. The backend does not accept database credentials from API request bodies or configuration files checked into version control.

### 12.3 Minimum Privilege

The PostgreSQL user used by the backend application has the following grants only:

```sql
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA public TO sscope_app;
GRANT UPDATE (api_key_hash) ON devices TO sscope_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO sscope_app;
```

The application user does NOT have `CREATE`, `DROP`, `TRUNCATE`, `ALTER`, or superuser privileges. Schema migrations run as a separate migration user with elevated privileges.

**(CX-S-4 — 2026-11-02: narrowed `sscope_app` grants from `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` to `SELECT, INSERT ON ALL TABLES` plus a column-level `UPDATE (api_key_hash) ON devices` only. `UPDATE` on all other tables and `DELETE` on all tables are not needed by the MVP application. Grant aligned with `ARCHITECTURE.md §6.1`.)**

---

## 13. Provenance Field Immutability

### 13.1 Provenance Fields

The following fields on the `sessions` table are immutable after insert: `source`, `source_marker`, `import_timestamp`. **(CX-S-2 — 2026-11-02: corrected table name from `runs` to `sessions`; the correct table per `ARCHITECTURE.md §6.1` is `sessions`.)**

### 13.2 Enforcement

Immutability is enforced at two layers:

**Application layer:** There is no UPDATE code path for provenance fields. The application code contains no SQL that sets `source`, `source_marker`, or `import_timestamp` in an UPDATE statement.

**Database layer:** A BEFORE UPDATE trigger prevents modification even if the application layer is bypassed (e.g., via a direct database connection or a future code path):

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

**Threat addressed:** T6 — prevents retroactive provenance tampering.

---

## 14. Logging

### 14.1 Log Format

Structured JSON logs. Each log entry includes: timestamp (RFC 3339), severity level, message, and a structured `fields` object. No free-form string concatenation in log statements.

### 14.2 What to Log

| Event | Level | Fields to include |
|---|---|---|
| API request | INFO | method, path, status code, duration_ms, device_id (not key) |
| Authentication failure | WARN | reason, device_id or IP address |
| Import rejection | WARN | rejection reason, file_size_bytes or depth/count at failure (not file contents) |
| Rate limit exceeded | WARN | endpoint, device_id or IP |
| Database error | ERROR | error code (not SQL query text, not parameter values) |
| Startup | INFO | version, listen address (not DB password) |

### 14.3 What NOT to Log

The following MUST NOT appear in any log output:

- API key plaintext
- Setup token plaintext
- Dashboard password plaintext
- Session cookie values
- Database passwords
- Request body contents (they may contain the setup token during registration)
- Stack traces in production (log to an internal error log; do not return to clients)
- File contents from imports

**Setup token log safety:** The setup token is printed to stdout at startup as described in §5.2. It is NOT written to the application's structured log stream (the log used by log aggregators, `journald`, etc.). The stdout print and the structured log are separate streams.

---

## 15. Security Test Cases

### ST-01 — API key required for run submission

**Input:** `POST /api/v1/runs` with no `Authorization` header.
**Expected:** HTTP 401 Unauthorized.

### ST-02 — Invalid API key rejected

**Input:** `POST /api/v1/runs` with `Authorization: Bearer invalid-key`.
**Expected:** HTTP 401 Unauthorized. Response time is constant (timing-safe comparison).

### ST-03 — Setup token one-time use

**Steps:** Register one device successfully. Attempt to register a second device with the same token.
**Expected:** Second registration returns HTTP 409. First device's API key remains valid.

### ST-04 — Setup token not accepted as CLI argument

**Input:** Inspect CLI argument parser for any `--token` or equivalent flag on `sscope register`.
**Expected:** Flag does not exist. Token is never in argv.

### ST-05 — JSON import does not execute embedded strings

**Input:** Import a JSON file where `name` is `"; rm -rf /; echo "` and `run_name` is `<script>alert(1)</script>`.
**Expected:** Values stored as literal strings. No command executed. No script executed when rendered in dashboard.

### ST-06 — JSON import entry count limit

**Input:** A valid JSON file with 10,001 benchmark entries.
**Expected:** Import rejected with error before parsing completes. No partial data written to database.

### ST-07 — JSON import nesting depth limit

**Input:** A JSON object nested 33 levels deep.
**Expected:** Parser aborts with error at depth 33. No partial data written.

### ST-08 — JSON import file size limit (pre-read)

**Input:** A file of 50 MiB + 1 byte.
**Expected:** Rejected at stat() check before file is opened for reading.

### ST-09 — JSON import file size limit (TOCTOU)

**Input:** A file that is <= 50 MiB at stat() time but grows to > 50 MiB during streaming read (simulated via a named pipe or test double).
**Expected:** Byte counter aborts the read. Import rejected. No partial data written.

### ST-10 — Oversized run submission body

**Input:** `POST /api/v1/runs` with body > 25 MiB.
**Expected:** HTTP 413 Request Entity Too Large before body is fully read.

### ST-11 — Rate limiting on internet-accessible deployment

**Input:** Submit 101 requests to a data endpoint within 60 seconds from the same device.
**Expected:** The 101st request returns HTTP 429 with a `Retry-After` header.

### ST-12 — Provenance immutability (application layer)

**Input:** Submit a run. Attempt to update `source` via any available API endpoint.
**Expected:** No API endpoint exists that sets `source`, `source_marker`, or `import_timestamp`. Verified by API contract inspection.

### ST-13 — Provenance immutability (database layer)

**Input:** Execute `UPDATE runs SET source = 'tampered' WHERE id = <valid_id>` directly on the database.
**Expected:** Trigger raises exception. UPDATE rolls back. Row unchanged.

### ST-14 — XSS prevention in dashboard

**Input:** Import a benchmark with `name` = `<img src=x onerror=alert(1)>`.
**Expected:** Dashboard renders the string as literal text. No alert fires. Inspecting the DOM shows the string is in a text node, not parsed as HTML.

### ST-15 — Dashboard requires authentication

**Input:** `GET /dashboard/` with no session cookie.
**Expected:** HTTP 302 redirect to `/dashboard/login`.

### ST-16 — Session cookie is HttpOnly

**Input:** Log in to dashboard. Inspect the `Set-Cookie` response header.
**Expected:** Cookie has `HttpOnly`, `SameSite=Strict`, and `Secure` (in HTTPS deployment) attributes. JavaScript `document.cookie` cannot access it.

### ST-17 — No stack traces in error responses

**Input:** Send a malformed request that triggers a server-side exception.
**Expected:** Response body contains structured error JSON with code and message. No stack trace, file path, or SQL text in response body.

### ST-18 — API key stored in Keychain, not plaintext file

**Steps:** Run `sscope register`. Inspect `~/.config/sscope/` for plaintext key files.
**Expected:** No plaintext key file present. Key is in macOS Keychain only.

### ST-19 — Configuration directory permissions

**Steps:** Run `sscope register`. Check permissions on `~/.config/sscope/`.
**Expected:** Directory has mode `0700`. Files within have mode `0600`.

### ST-20 — Security headers present

**Input:** Any backend HTTP response.
**Expected:** Response includes `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and `Content-Security-Policy` header.

### ST-21 — HSTS present on HTTPS deployment

**Input:** Any HTTPS response from production backend.
**Expected:** Response includes `Strict-Transport-Security: max-age=31536000`.

### ST-22 — DB password not in logs

**Input:** Start backend with `SSCOPE_DB_PASSWORD` set. Collect all log output.
**Expected:** No log line contains the password value.

### ST-23 — Setup token not in structured log

**Input:** Start backend. Collect structured JSON log output (not stdout).
**Expected:** Setup token does not appear in any structured log entry.

### ST-24 — sslmode=verify-full for remote DB

**Input:** Configure backend to connect to a remote PostgreSQL instance with a self-signed cert, using `sslmode=verify-full` without providing `SSCOPE_DB_SSLROOTCERT`.
**Expected:** Connection fails (certificate verification error). Backend refuses to start or returns startup error.

### ST-25 — No remote execution channel

**Input:** Inspect all backend response payloads and WebSocket messages (if any) for fields that could be interpreted as commands by the agent.
**Expected:** No response payload contains `command`, `exec`, `script`, `shell`, or equivalent fields. Verified by API contract inspection.

---

## 16. MVP-Essential vs. Deferred Hardening

### 16.1 MVP-Essential (must be implemented before any deployment)

- API key authentication on all agent endpoints (ST-01, ST-02)
- One-time setup token with hidden-input prompt (ST-03, ST-04)
- Dashboard password authentication with HttpOnly session cookie (ST-15, ST-16)
- JSON import entry count and nesting depth limits enforced in-process (ST-06, ST-07)
- TOCTOU defense with byte counter during read (ST-09)
- 25 MiB run submission body limit (ST-10)
- Provenance immutability trigger (ST-12, ST-13)
- XSS prevention (no `dangerouslySetInnerHTML` on imported strings) (ST-14)
- Security response headers (ST-20)
- No stack traces in production error responses (ST-17)
- PostgreSQL minimum-privilege user (§12.3)
- `sslmode=verify-full` for remote production database (ST-24)

### 16.2 Required for Internet-Accessible Deployment (not required for localhost-only)

- Rate limiting (ST-11)
- HSTS header (ST-21)
- `Secure` attribute on session cookie (§5.3)
- CA-signed TLS certificate (§6)

### 16.3 Safely Deferred

| Feature | Reason for deferral |
|---|---|
| Automatic API key rotation | Single-user; manual re-registration is sufficient |
| API key expiry | Single-user; keys last until revoked |
| RBAC / per-resource authorization | Single-user MVP has no multi-user access model |
| Certificate pinning | Standard TLS verification sufficient for MVP |
| Audit log (append-only, signed) | Provenance trigger covers the key tamper-resistance requirement |
| Linux Keychain support (libsecret) and `SSCOPE_API_KEY` env-var fallback | Linux is a deferred platform (PROJECT.md §5.1); neither Linux Keychain support nor the `SSCOPE_API_KEY` env-var fallback is an MVP requirement |
| Multi-token registration (queue) | Restart-to-regenerate is acceptable for MVP |
| OAuth / SSO | Not required for single-user tool |

---

## 17. Cross-Document Changes Required

The following changes to other documents are identified but NOT yet made. Each requires separate approval.

| ID | Document | Section | Change required |
|---|---|---|---|
| CX-1 | PROJECT.md | §5.1 CLI commands | Add `sscope register --backend <url>` command description and hidden-prompt behavior |
| CX-2 | BENCHMARK_SPEC.md | §9.2 or equivalent | Add benchmark record count limit (10,000 items in the `benchmarks` array), nesting depth limit (32), and TOCTOU defense reference; also add explicit byte-length limits for `run_name` (proposed: ≤ 1,024 bytes) and `aggregate_name` (proposed: ≤ 64 bytes) — both required to confirm the provisional 25 MiB API body limit in §9.2 |
| CX-3 | REQUIREMENTS.md | FR-D (Dashboard) | Add explicit dashboard authentication requirement (SSCOPE_DASHBOARD_PASSWORD, session cookie) |
| CX-4 | REQUIREMENTS.md | SEC-001, FR-B-003 | Clarify that the remote execution allowlist is a forward-looking architectural constraint; no backend-to-agent remote execution channel exists in MVP. FR-B-003 currently states "The backend may trigger a predefined, enumerated set of synthetic benchmark operations on the registered agent" — this must be revised to reflect that no such triggering channel is implemented in MVP; the allowlist is a future constraint only. |
| CX-4b | PROJECT.md | §5.3 | §5.3 currently states "Remote-triggered operations are restricted to a predefined, validated set of synthetic benchmark operations." This implies a remote triggering channel exists in MVP. Update to clarify this is a future architectural constraint and that no backend-to-agent execution channel is implemented in MVP. |
| CX-5 | API_CONTRACTS.md | Run submission endpoint | Reference 25 MiB body limit, 10,000 row limit, and provenance field names (when document is written) |
| CX-6 | API_CONTRACTS.md | Registration endpoint | Document `POST /api/v1/register` request/response schema, HTTP 409 behavior, and one-time-use semantics (when document is written) |
