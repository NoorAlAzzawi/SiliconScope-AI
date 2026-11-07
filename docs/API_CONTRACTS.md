# SiliconScope AI — API Contracts

**Status:** Approved  
**Version:** 0.1.0  
**Last updated:** 2026-11-01  
**Resolves:** OQ-5 (API versioning), B-1 (canonical fingerprint algorithm)  
**Security specification:** `docs/SECURITY.md`  
**Architecture reference:** `ARCHITECTURE.md`  
**Benchmark specification:** `docs/BENCHMARK_SPEC.md`  
**Requirements:** `REQUIREMENTS.md`

This document is authoritative for all MVP REST API endpoint schemas, the canonical content fingerprint algorithm, the idempotent submission protocol, and comparison eligibility rules at the API boundary. Where this document defers to another specification, that document is binding.

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [API Versioning](#2-api-versioning)
3. [Common Conventions](#3-common-conventions)
4. [Endpoints](#4-endpoints)
5. [Canonical Content Fingerprint](#5-canonical-content-fingerprint)
6. [Idempotent Submission Protocol](#6-idempotent-submission-protocol)
7. [Measurement Schema](#7-measurement-schema)
8. [Request and Record Limits](#8-request-and-record-limits)
9. [Comparison Eligibility and Environment Policy](#9-comparison-eligibility-and-environment-policy)
10. [Error Code Catalogue](#10-error-code-catalogue)
11. [Contract Test Cases](#11-contract-test-cases)
12. [Pending Cross-Document Amendments](#12-pending-cross-document-amendments)

---

## 1. Purpose and Scope

This document resolves the open questions and implementation prerequisites assigned to `docs/API_CONTRACTS.md` in `ARCHITECTURE.md` §13:

| Blocker | Resolution |
|---|---|
| B-1 | Canonical fingerprint algorithm: §5 (serialization format: RFC 8785 JCS; C++ library selection: pending — see §5.7) |
| B-2 | API versioning (OQ-5): §2 |

**Field name disambiguation.** Three fields share related names at different levels of the data hierarchy:

| Field | Level | Constraint | Source |
|---|---|---|---|
| `run_name` | Session | ≤ 1,024 bytes; non-empty | Pending CX-2 to `docs/BENCHMARK_SPEC.md` |
| `canonical_name` | Benchmark case | ≤ 1,024 bytes; byte-exact; no normalization | `docs/BENCHMARK_SPEC.md` §8.4 |
| `aggregate_name` | Measurement row | ≤ 64 bytes; non-empty when present | Pending CX-2 to `docs/BENCHMARK_SPEC.md` |

`run_name` is a session-level human-readable label set by the agent. `canonical_name` is the per-case benchmark identifier derived from the Google Benchmark JSON `run_name` field or `name` field per `docs/BENCHMARK_SPEC.md` §9.6. `aggregate_name` is a field within individual measurement rows identifying the statistic type (e.g., `"mean"`, `"stddev"`). These are distinct fields at distinct levels; none is a synonym for another.

---

## 2. API Versioning

**Decision (OQ-5):** URL-prefix versioning with `/api/v1/` for all MVP endpoints.

- All agent-facing and dashboard-facing data endpoints are prefixed `/api/v1/`.
- A version-discovery endpoint is available at `GET /api/version` (no prefix) and returns the active API version.
- Backward compatibility within `/api/v1/` is additive only: new optional fields may be added to responses; existing fields are never removed or renamed within a version.
- A breaking change requires a new prefix (e.g., `/api/v2/`). No `/api/v2/` endpoints exist in the MVP.
- No `Accept-Version` or `API-Version` header negotiation. Version is determined solely by URL prefix.

---

## 3. Common Conventions

### 3.1 Error Response Format

All `4xx` and `5xx` responses return `Content-Type: application/json` with the following body:

```json
{
  "error": {
    "code": "<SCREAMING_SNAKE_CASE string>",
    "message": "<human-readable explanation>",
    "details": [
      { "field": "<field path>", "issue": "<description>" }
    ]
  }
}
```

`details` is present only for `VALIDATION_ERROR` and `COMPARISON_INELIGIBLE` responses. It may be absent or an empty array for all other error codes.

**Amendment note:** `REQUIREMENTS.md` ERR-008 specifies a flat `error_code` field; `docs/SECURITY.md` §11.3 specifies the nested `{"error": {"code": ...}}` shape adopted here. CX-RM-1 in §12 documents the required update to `REQUIREMENTS.md`.

### 3.2 HTTP Status Codes

| Code | When used |
|---|---|
| 200 | Identical idempotent retry (session already exists with matching fingerprint) |
| 201 | New resource created (session, comparison, device registration) |
| 400 | Invalid record: missing required field, wrong type, out-of-range value, non-finite numeric, record count limit exceeded (`REQUIREMENTS.md` FR-B-005) |
| 401 | Missing or invalid credential |
| 403 | Valid credential; insufficient scope for this route |
| 404 | Requested resource does not exist |
| 409 | Conflict: `session_id` already exists with a different fingerprint, or setup token already consumed |
| 413 | Request body exceeds the configured size limit |
| 422 | Semantic condition: `FINGERPRINT_MISMATCH` or `COMPARISON_INELIGIBLE` |
| 500 | Unexpected server error; safe to retry |
| 503 | Backend temporarily unavailable; retry with exponential backoff |

### 3.3 Authentication

Per `docs/SECURITY.md` §5:

| Credential | Transport | Used by |
|---|---|---|
| Agent API key | `Authorization: Bearer <key>` header | Agent write and read routes |
| One-time setup token | Request body field `setup_token` | `POST /api/v1/register` only |
| Dashboard session cookie | `Cookie` header (HttpOnly, SameSite=Strict, Path=`/`, Secure, Max-Age=86400) | Dashboard read and comparison routes |

Route authorization matrix is defined in `ARCHITECTURE.md` §5.3. Dashboard sessions never authorize `POST /api/v1/runs` or `POST /api/v1/register`.

### 3.4 Pagination

All list endpoints accept `page` (1-indexed, default 1) and `page_size` (default 25, maximum 100) as query parameters. All list responses use this envelope:

```json
{
  "data": [ ... ],
  "pagination": {
    "page": 1,
    "page_size": 25,
    "total_count": 101,
    "total_pages": 5
  }
}
```

An empty result set returns HTTP 200 with `"data": []` and `"total_count": 0`. HTTP 404 is never returned for an empty list.

### 3.5 import_timestamp Format

The agent generates `import_timestamp` exactly once, at the moment of local persistence, as a UTC ISO 8601 string with second precision: `YYYY-MM-DDTHH:mm:ssZ`. Sub-second precision is intentionally omitted. The value is stored verbatim in local SQLite and submitted unchanged on every retry. The backend stores it in the `import_timestamp TIMESTAMPTZ` column; the `DEFAULT now()` is a safety net and is not used in normal operation.

---

## 4. Endpoints

### 4.1 GET /api/version

No authentication required.

**Response 200:**
```json
{
  "api_version": "v1",
  "min_agent_version": "0.1.0"
}
```

### 4.2 POST /api/v1/register

Authentication: setup token in request body (one-time use). No API key. No dashboard session.  
Registration protocol: `docs/SECURITY.md` §5.2 (9-step mutex).

**Request body:**
```json
{
  "device_id":   "<UUID v4, agent-generated before first registration>",
  "device_name": "<non-empty string, e.g. hostname>",
  "setup_token": "<256-bit base64url plaintext token>"
}
```

`device_id` is a UUID v4 generated by the agent once and stored as the macOS Keychain account identifier. On re-registration (replacing a lost or rotated key), the same `device_id` is submitted so the backend can locate and atomically replace the existing key row. The `platform` hardware fields are captured per-run and stored in the `sessions` table, not in the `devices` table; they are absent from this request.

**Response 201:**
```json
{
  "device_id": "<UUID>",
  "api_key": "<plaintext API key — shown once; never stored on backend>"
}
```

**Error responses:**

| Code | Error code | Condition |
|---|---|---|
| 401 | `SETUP_TOKEN_INVALID` | Token missing, invalid, or already used |
| 409 | `SETUP_TOKEN_CONSUMED` | Token was consumed at step 5 of the mutex protocol but the database write failed; server restart required to issue a new token |

Re-registration (same device_id): the existing API key is atomically replaced per `docs/SECURITY.md` §5.1. The old key is invalid immediately after the new key is issued.

### 4.3 POST /api/v1/runs

Authentication: agent API key.  
Body size limit: 25 MiB (provisional; see §8).  
Idempotency: see §6.

**Request body:**

```json
{
  "session_id":           "<UUID v4, agent-generated>",
  "run_name":             "<string, ≤ 1,024 bytes, non-empty>",
  "os_name":              "<string, non-empty>",
  "os_version":           "<string, non-empty>",
  "cpu_name":             "<string, non-empty>",
  "isa":                  "<string, non-empty>",
  "build_type":           "<string, non-empty>",
  "source":               "synthetic | user-supplied import",
  "source_marker":        "<string | null>",
  "git_sha":              "<string | null>",
  "build_config":         "<string | null>",
  "import_timestamp":     "<YYYY-MM-DDTHH:mm:ssZ>",
  "import_environment":   <environment object | null>,
  "submitted_fingerprint":"<64 lowercase hex characters>",
  "benchmarks": [
    {
      "project_name":   "<string, non-empty>",
      "canonical_name": "<string, ≤ 1,024 bytes, non-empty>",
      "data_type":      "raw_samples_available | aggregate_only | no_measurements",
      "measurements":   <measurements object — see §7>
    }
  ]
}
```

`import_environment` is `null` for `source = "synthetic"`. For `source = "user-supplied import"` it carries the hardware and OS snapshot of the **importing machine** at import time (FR-I-012), which may differ from the execution-time environment in the scalar fields. Shape:

```json
{
  "cpu_name":      "<string>",
  "isa":           "<string>",
  "logical_cores": <positive integer>,
  "memory_bytes":  <non-negative integer>,
  "os_name":       "<string>",
  "os_version":    "<string>",
  "physical_cores": <positive integer>
}
```

Fields within `import_environment` stored as `"unavailable"` are serialized verbatim. The backend must not reject an `import_environment` object because one or more fields are `"unavailable"`.

`device_id` is not in the request body. The backend resolves it from the authenticated API key.

`submitted_fingerprint` is required. The backend independently recomputes the fingerprint from the validated submitted content per §5. A mismatch returns 422 `FINGERPRINT_MISMATCH`; the session is not stored.

**Response 201 (new session accepted):**
```json
{ "session_id": "<UUID>" }
```

**Response 200 (identical retry):**
```json
{ "session_id": "<UUID>" }
```

**Error responses:**

| Code | Error code | Condition |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Missing required field, wrong type, out-of-range value, non-finite numeric |
| 400 | `BENCHMARK_LIMIT_EXCEEDED` | `benchmarks` array length > 10,000 |
| 400 | `DUPLICATE_BENCHMARK_CASE` | Two or more entries in `benchmarks` share the same `(project_name, canonical_name)` pair |
| 409 | `SESSION_CONFLICT` | `session_id` exists with a different `content_fingerprint` |
| 413 | `PAYLOAD_TOO_LARGE` | Body exceeds 25 MiB limit |
| 422 | `FINGERPRINT_MISMATCH` | `submitted_fingerprint` does not match backend-computed fingerprint |

### 4.4 GET /api/v1/runs

Authentication: agent API key or dashboard session.

**Query parameters:**

| Parameter | Type | Description |
|---|---|---|
| `page` | integer ≥ 1 | Page number (default: 1) |
| `page_size` | integer 1–100 | Results per page (default: 25) |
| `source` | `synthetic` \| `user-supplied import` | Filter by source (optional) |
| `date_from` | `YYYY-MM-DD` | Inclusive start date on `import_timestamp` (optional) |
| `date_to` | `YYYY-MM-DD` | Inclusive end date on `import_timestamp` (optional) |

**Response 200:**
```json
{
  "data": [
    {
      "session_id":       "<UUID>",
      "run_name":         "<string>",
      "source":           "<string>",
      "import_timestamp": "<ISO 8601>",
      "submitted_at":     "<ISO 8601>",
      "os_name":          "<string>",
      "cpu_name":         "<string>",
      "isa":              "<string>",
      "git_sha":          "<string | null>",
      "benchmark_count":  <integer>
    }
  ],
  "pagination": {
    "page": 1,
    "page_size": 25,
    "total_count": 42,
    "total_pages": 2
  }
}
```

Default sort: `import_timestamp` descending.

### 4.5 GET /api/v1/runs/:id

Authentication: agent API key or dashboard session.

**Response 200** — full session record including all `benchmark_cases`:

```json
{
  "session_id":           "<UUID>",
  "run_name":             "<string>",
  "os_name":              "<string>",
  "os_version":           "<string>",
  "cpu_name":             "<string>",
  "isa":                  "<string>",
  "build_type":           "<string>",
  "source":               "<string>",
  "source_marker":        "<string | null>",
  "git_sha":              "<string | null>",
  "build_config":         "<string | null>",
  "import_timestamp":     "<ISO 8601>",
  "import_environment":   <object | null>,
  "submitted_at":         "<ISO 8601>",
  "content_fingerprint":  "<64 hex chars>",
  "benchmark_cases": [
    {
      "project_name":   "<string>",
      "canonical_name": "<string>",
      "data_type":      "<string>",
      "measurements":   <measurements object>
    }
  ]
}
```

**Response 404:** Session not found.

### 4.6 POST /api/v1/comparisons

Authentication: agent API key or dashboard session (approved; `docs/SECURITY.md` §5.3 update pending as CX-S-1 in §12).

**Request body:**
```json
{
  "session_a_id": "<UUID>",
  "session_b_id": "<UUID>"
}
```

Comparisons are not idempotent. Each request creates a new `comparison_id`. Session A is the baseline; Session B is the candidate.

**Response 201 (comparison computed, eligible or confounded):**
```json
{
  "comparison_id":      "<UUID>",
  "session_a_id":       "<UUID>",
  "session_b_id":       "<UUID>",
  "computed_at":        "<ISO 8601>",
  "confounding_factors": [
    {
      "flag":     "<flag identifier from BENCHMARK_SPEC.md §7.2>",
      "severity": "Low | Medium | High",
      "value_a":  "<string>",
      "value_b":  "<string>"
    }
  ],
  "mandatory_disclaimer": "<verbatim text from BENCHMARK_SPEC.md §4.3, or null if no confounding>",
  "per_metric_results": [
    {
      "project_name":    "<string>",
      "canonical_name":  "<string>",
      "metric":          "<string>",
      "polarity":        "LIB | HIB",
      "classification":  "<label from BENCHMARK_SPEC.md §6.6 or §6.3>",
      "flags":           ["<flag strings>"],
      "delta_pct":       <number | null>,
      "regression_effect": <number | null>,
      "t_statistic":     <number | null>,
      "p_raw":           <number | null>,
      "p_adjusted":      <number | null>,
      "reason_code":     "<string | null>"
    }
  ],
  "overall_summary": {
    "label":   "<label from BENCHMARK_SPEC.md §6.9>",
    "k1": <integer>, "k2": <integer>, "k3": <integer>, "k4": <integer>,
    "m":  <integer>
  },
  "rule_based_explanation": "<string>"
}
```

A confounded comparison returns 201 with `confounding_factors` populated and `mandatory_disclaimer` set to the verbatim text from `docs/BENCHMARK_SPEC.md` §4.3. There is no override mechanism; the comparison always proceeds unless a blocking condition (§9.1) applies.

**Response 422 `COMPARISON_INELIGIBLE`** — blocking condition met:
```json
{
  "error": {
    "code": "COMPARISON_INELIGIBLE",
    "message": "Comparison is blocked.",
    "details": [
      { "field": "isa", "issue": "Different ISA: arm64 vs x86_64" }
    ]
  }
}
```

**Response 400** — malformed request: missing `session_a_id` or `session_b_id`, non-UUID value, or both IDs are the same session.

**Response 404** — one or both `session_id` values are well-formed UUIDs but do not exist in the database. The `details` array identifies which ID was not found. (Required by `REQUIREMENTS.md` FR-B-009.)

### 4.7 GET /api/v1/comparisons/:id

Authentication: agent API key or dashboard session.

**Response 200:** Full comparison record as defined in §4.6 response, plus `comparison_id` and `computed_at`.

**Response 404:** Comparison not found.

### 4.8 POST /dashboard/login

Authentication: password in form-encoded body (per `docs/SECURITY.md` §5.4).

**Request body** (`application/x-www-form-urlencoded`): `password=<value>`

**Response 200:** Sets `Set-Cookie` with session cookie. Cookie attributes: HttpOnly, SameSite=Strict, Path=`/`, Secure, Max-Age=86400.

**Response 401:** Invalid password.

### 4.9 POST /dashboard/logout

Authentication: dashboard session cookie.

**Response 200:** The backend invalidates the server-side session record first (per `docs/SECURITY.md` §5.3 — sessions are not stateless JWT tokens). The response then sets `Max-Age=0` on the cookie. Subsequent requests bearing the same cookie value are rejected with 401 because the session no longer exists server-side. Returns 200 even if no valid session exists for the presented cookie (idempotent).

---

## 5. Canonical Content Fingerprint

### 5.1 Purpose

The canonical content fingerprint is a SHA-256 hash of the RFC 8785 JCS serialization of a defined subset of a session's immutable submitted data. It serves two purposes:

1. **Integrity verification:** The agent submits its pre-computed fingerprint alongside the session data. The backend independently recomputes the fingerprint from the validated content. A mismatch indicates data corruption in transit or an implementation divergence.
2. **Idempotent sync:** On retry, the backend compares the newly computed fingerprint against the stored `content_fingerprint` for the same `session_id`. A match returns 200; a mismatch returns 409.

### 5.2 Fields Included

**Session-level fields** (all required; nullable fields included as JSON `null` when absent):

`run_name`, `os_name`, `os_version`, `cpu_name`, `isa`, `build_type`, `source`, `source_marker`, `import_timestamp`, `git_sha`, `build_config`, `import_environment`

**Per benchmark case** (all cases; sorted by composite key — see §5.3):

`project_name`, `canonical_name`, `data_type`, `measurements` (complete verbatim object as stored; each row within `raw_rows` and `aggregate_rows` includes `bytes_per_second`, `items_per_second`, and `unknown_fields` per row — see §7)

**Excluded:** `session_id`, `device_id`, `submitted_at`, `content_fingerprint`, `submitted_fingerprint`, `benchmark_count`, and all backend-assigned fields.

`import_environment` is included because it is part of the complete immutable submitted record. Different import contexts produce different fingerprints, even for identical benchmark data — this is correct, as each import is a distinct submission. A synthetic session always has `import_environment: null` in the canonical object.

### 5.3 Canonical Object F

The canonical object F has this exact shape, with all keys present. Absent nullable fields always appear as JSON `null` — never omitted.

```json
{
  "build_config":       "<string | null>",
  "build_type":         "<string>",
  "cases": [
    {
      "canonical_name": "<string>",
      "data_type":      "<string>",
      "measurements":   <complete measurements object>,
      "project_name":   "<string>"
    }
  ],
  "cpu_name":           "<string>",
  "git_sha":            "<string | null>",
  "import_environment": <object | null>,
  "import_timestamp":   "<string>",
  "isa":                "<string>",
  "os_name":            "<string>",
  "os_version":         "<string>",
  "run_name":           "<string>",
  "source":             "<string>",
  "source_marker":      "<string | null>",
  "v":                  1
}
```

`v: 1` is an integer algorithm-version tag. If the fingerprint definition ever changes, `v` is incremented and all existing fingerprints with prior `v` values are invalidated.

**Cases sort key:** Sort `cases` by `project_name + "\x00" + canonical_name` using UTF-8 byte-order comparison. The null-byte separator prevents collisions between `("ab", "c")` and `("a", "bc")`.

**`import_environment` key order in canonical object:** Object keys are sorted per RFC 8785 §3.2.3 (UTF-16 code unit order). The `import_environment` object is included verbatim in this sorted form. Fields stored as `"unavailable"` serialize as the string `"unavailable"`.

**`measurements` in canonical object:** The complete stored measurements object is included verbatim, with all keys RFC 8785-sorted recursively, and all numeric values canonicalized per §5.5.

### 5.4 Serialization: RFC 8785 JSON Canonicalization Scheme

This document adopts **RFC 8785 (JSON Canonicalization Scheme)** as the normative serialization standard for fingerprint computation. The serialization must conform to RFC 8785 §3 in full. Key properties:

- Object keys sorted by **UTF-16 code unit order** (ES2019 `Object.keys()` lexicographic ordering, per RFC 8785 §3.2.3). For BMP code points (U+0000–U+FFFF) this is identical to Unicode code point order. For supplementary plane code points (U+10000+), encoded as surrogate pairs in UTF-16 (high surrogates 0xD800–0xDBFF), comparison is by UTF-16 code unit value, not by scalar code point value: a supplementary character's high surrogate (e.g., 0xD800 = 55296) sorts before any BMP character above U+D7FF (e.g., U+E000 = 57344). This distinction affects `unknown_fields` keys containing user-supplied non-ASCII content; it does not affect any fixed key in canonical object F (all BMP). A C++ implementation using code-point ordering will diverge from the TypeScript reference for such keys.
- String values encoded per RFC 8259 minimal escaping: `\"` for U+0022, `\\` for U+005C, `\uXXXX` for U+0000–U+001F and U+007F. No other escaping.
- Numbers serialized per §5.5 below.
- `null` as four literal characters.
- No insignificant whitespace.
- UTF-8 output, no BOM.

**TypeScript reference implementation:** The `json-canonicalize` npm package (version ≥ 1.0.6), authored by Samuel Erdtman, is the RFC 8785 reference implementation. Use it directly with no modification.

**C++ implementation: SELECTED — Option B, custom serializer with Ryu library. (B-1 resolved — 2026-11-02)**

`nlohmann/json.dump()` is **not** a conformant RFC 8785 implementation and must not be used for fingerprint serialization.

The selected implementation uses five components, all validated test-first against the CT vectors in §5.8:

1. **Number serialization — Ryu library (vendored).** `std::to_chars` with `chars_format::general` does NOT produce ES2019-compliant output for all values. It selects notation by string length, which diverges from ES2019 for values where fixed notation is longer than scientific (e.g., `1e15` → ES2019 requires `"1000000000000000"` per its rule that fixed notation is used for all values with absolute magnitude below 10^21, but `std::to_chars` may emit `"1e+15"` as the shorter form). The **Ryu** library (Ulf Adams, MIT license, vendored at `agent/third_party/ryu/`) implements ES2019 `Number::toString` semantics correctly, including the fixed-vs-scientific notation rule. Ryu is ~500 lines of C in a single source file with no dependencies.

2. **Integer-valued doubles.** Detected with `v == std::floor(v) && std::abs(v) <= 9007199254740992.0` (2^53) before calling Ryu. Formatted via `std::to_chars(buf, end, (long long)v)`. Produces no decimal point or exponent: `100.0` → `"100"`. (CT-NUM-01, CT-NUM-04, CT-NUM-07.)

3. **Negative zero.** Detected with `std::signbit(v) && v == 0.0` before all other cases. Output is the literal string `"0"`. (CT-NUM-08.)

4. **UTF-16 key ordering.** A custom `utf16_less(string_view a, string_view b)` comparator decodes each UTF-8 key to Unicode scalar values and compares by UTF-16 code unit sequence. For supplementary-plane keys (U+10000+), the high surrogate (0xD800–0xDBFF) is the effective comparison value; this causes supplementary-plane characters to sort before BMP characters above U+D7FF (e.g., U+10000 high surrogate 0xD800 = 55296 < U+E000 = 57344). `std::string::operator<` compares by byte value and will give the wrong order for supplementary-plane keys. (CT-RFC8785-04 — the highest-risk divergence vector.)

5. **String escaping.** Minimal per RFC 8259: `\"` for U+0022, `\\` for U+005C, `\uXXXX` for U+0000–U+001F and U+007F. No other escaping is applied. (CT-RFC8785-02, CT-RFC8785-03.)

Source files: `agent/include/sscope/fingerprint/fingerprint.h`, `agent/src/fingerprint/fingerprint.cpp`, `agent/third_party/ryu/`.

All five components must pass CT-NUM-01–09, CT-RFC8785-01–04, and CT-CROSS-01 before any agent sync code is merged. This hard gate is unchanged from the previous state of this section.

### 5.5 Numeric Serialization (ES2019 Number::toString)

RFC 8785 §3.2.2 specifies ES2019 Number::toString semantics for JSON numbers. The precise rule:

1. **Integer-valued IEEE 754 doubles** (`v == floor(v)` and `|v| ≤ 2^53 − 1`): serialize as a plain decimal integer string. No decimal point; no exponent. Example: `100.0` → `"100"`.
2. **All other finite doubles:** serialize using the shortest decimal string that round-trips to the same IEEE 754 double (Ryu algorithm). Example: `1.5` → `"1.5"`, `100.333` → `"100.333"`.
3. **Negative zero** (`-0.0`): serialize as `"0"` (ES2019 `Number.prototype.toString(-0)` = `"0"`).
4. **Non-finite values** (NaN, ±Infinity): rejected at the API validation boundary with 400 `VALIDATION_ERROR`. These values must never reach the fingerprint function.
5. **Scientific notation:** not used for values in the valid range. ES2019 uses scientific notation only for values with absolute magnitude ≥ 10^21 or < 10^-6. All measurement values are bounded within `(0, 10^15]` by `docs/BENCHMARK_SPEC.md` §9.10 and `import_environment` fields are positive integers; no scientific notation arises.

### 5.6 Hashing and Encoding

```
jcs_bytes           = RFC 8785 serialization of F (UTF-8 encoded)
fingerprint_bytes   = SHA-256(jcs_bytes)           [FIPS 180-4]
content_fingerprint = lowercase_hex(fingerprint_bytes)  [64 characters]
```

### 5.7 Reference Implementations

The agent (C++) computes the fingerprint before writing to local SQLite. The backend (TypeScript) independently recomputes from validated submitted content. Both use the same algorithm; the backend never stores the client-submitted fingerprint value.

**Agent (C++) — pending library selection per §5.4. Once a conformant RFC 8785 serializer is available:**

```
1. Build canonical object F as a JSON value with all keys present.
2. Apply RFC 8785 serializer to produce jcs_bytes (UTF-8).
3. Compute SHA-256(jcs_bytes).
4. Encode as 64 lowercase hex characters.
5. Store in local SQLite sessions.content_fingerprint.
6. Include as submitted_fingerprint in POST /api/v1/runs body.
```

**Backend (TypeScript):**

```typescript
import { canonicalize } from "json-canonicalize";  // RFC 8785 reference impl
import { createHash } from "crypto";

function computeFingerprint(session: SessionSubmission, cases: CaseSubmission[]): string {
  const F = buildCanonicalObject(session, cases);  // construct F per §5.3
  const jcs = canonicalize(F);                     // RFC 8785
  return createHash("sha256").update(jcs, "utf8").digest("hex");
}
```

### 5.8 Test Vectors

These vectors must be used to validate both the TypeScript and C++ implementations before any sync code is merged.

**Numeric serialization (CT-NUM):**

| ID | Input IEEE 754 double | Expected canonical string |
|---|---|---|
| CT-NUM-01 | `100.0` (integer-valued) | `100` |
| CT-NUM-02 | `1.5` | `1.5` |
| CT-NUM-03 | `100.333` (nearest representable) | `100.333` |
| CT-NUM-04 | `1500.0` (e.g., `1.5 × 1000` after unit conversion) | `1500` |
| CT-NUM-05 | `1500.3` (e.g., `1.5003 × 1000`) | `1500.3` |
| CT-NUM-06 | `4294967296.5` (throughput counter float) | `4294967296.5` |
| CT-NUM-07 | `1e15` (maximum valid measurement value) | `1000000000000000` |
| CT-NUM-08 | `-0.0` (negative zero) | `0` |
| CT-NUM-09 | `0.1` | `0.1` |

**RFC 8785 key ordering and string escaping (CT-RFC8785):**

| ID | Input | Expected canonical output |
|---|---|---|
| CT-RFC8785-01 | Object `{"é": 1, "a": 2, "Z": 3}` | `{"Z":3,"a":2,"é":1}` (code points: Z=0x5A < a=0x61 < é=0xE9) |
| CT-RFC8785-02 | String containing U+0000 | ` ` escape in output |
| CT-RFC8785-03 | String `say "hello"\\world` | `"say \"hello\"\\world"` |
| CT-RFC8785-04 | Object with keys U+E000 (`""`) and U+10000 (`"𐀀"` surrogate pair) | `{"𐀀":2,"":1}` — UTF-16 high surrogate 0xD800 (55296) sorts before U+E000 (57344); code-point order (U+E000=57344 < U+10000=65536) would reverse this. Validates the divergence between UTF-16 code unit order and Unicode code point order for supplementary-plane keys. |

**Cross-implementation consistency (CT-CROSS-01):**  
Given the same `SessionRecord` + `BenchmarkCaseRecord[]` fixture, the TypeScript backend and C++ agent must produce byte-identical 64-character hex fingerprints. CT-NUM-01 through CT-NUM-09 and CT-RFC8785-01 through CT-RFC8785-04 must be embedded as field values in the fixture to exercise all edge cases. This test is run as a mandatory integration test before agent sync is merged.

---

## 6. Idempotent Submission Protocol

### 6.1 Session Identity

The agent generates a UUID v4 for each session before writing to local SQLite. The same `session_id` is used in every retry attempt. The backend never generates or reassigns session IDs.

### 6.2 Backend Fingerprint Verification

The backend performs these steps in order before any database operation:

1. Parse and validate all request body fields. Return 400 `VALIDATION_ERROR` on failure. Additionally check that no two entries in `benchmarks` share the same (`project_name`, `canonical_name`) pair; return 400 `DUPLICATE_BENCHMARK_CASE` if duplicates are found. This check must precede step 2 because a duplicate-case submission would produce a non-deterministic fingerprint.
2. Independently compute `content_fingerprint` from the validated content per §5.
3. Compare with `submitted_fingerprint`:
   - If different: return 422 `FINGERPRINT_MISMATCH`. Do not attempt any INSERT. This condition indicates data corruption in transit or a divergence between the agent and backend fingerprint implementations.
4. Proceed to the INSERT protocol (§6.3).

### 6.3 Concurrency-Safe INSERT Protocol

All session and benchmark-case insertions occur in a single database transaction. The two-statement approach below handles concurrent submissions of the same `session_id` correctly under PostgreSQL's default `READ COMMITTED` isolation level. A single-statement CTE is not used because the inline projection may share a stale snapshot that does not observe a concurrent committer's row.

```
BEGIN TRANSACTION

-- Statement 1: atomic conditional insert
result ← INSERT INTO sessions (session_id, device_id, run_name, os_name,
              os_version, cpu_name, isa, build_type, source, source_marker,
              git_sha, build_config, import_timestamp, import_environment,
              content_fingerprint)
          VALUES ($session_id, $device_id, ..., $backend_computed_fp)
          ON CONFLICT (session_id) DO NOTHING
          RETURNING session_id

if result.rowCount = 1:
    -- We inserted the sessions row; now insert all benchmark_cases
    INSERT INTO benchmark_cases (case_id, session_id, project_name,
        canonical_name, data_type, measurements)
    VALUES (...) for each case
    COMMIT
    → 201

-- result.rowCount = 0: session_id already existed (committed by another transaction).
-- Statement 2: separate SELECT at a new READ COMMITTED snapshot.
-- PostgreSQL's INSERT ON CONFLICT waits for the concurrent transaction to commit
-- or roll back before returning; this SELECT therefore always observes the committed row.

stored ← SELECT content_fingerprint FROM sessions WHERE session_id = $session_id

if stored.content_fingerprint = $backend_computed_fp:
    COMMIT
    → 200

else:
    ROLLBACK
    → 409 SESSION_CONFLICT
```

### 6.4 Response Semantics

| Condition | Code | Body |
|---|---|---|
| `submitted_fingerprint` ≠ backend-computed | 422 | `FINGERPRINT_MISMATCH` |
| New session; committed | 201 | `{"session_id": "<uuid>"}` |
| Identical retry; fingerprints match | 200 | `{"session_id": "<uuid>"}` |
| Same `session_id`; fingerprints differ | 409 | `SESSION_CONFLICT` |

201 is returned only after the transaction commits successfully. The backend never returns 201 speculatively.

### 6.5 Agent Retry Behavior

| Outcome | Agent action |
|---|---|
| 201 or 200 | Mark `sync_status = 'synced'` in local SQLite |
| Network error / timeout | Retry on next CLI invocation; `sync_status` remains `'pending'` |
| 409 `SESSION_CONFLICT` | Mark `sync_status = 'conflict'`; surface named error to user |
| 422 `FINGERPRINT_MISMATCH` | Do not retry; surface as implementation error requiring investigation |
| 413 `PAYLOAD_TOO_LARGE` | Mark `sync_status = 'pending'` with `sync_reason = 'body_limit_exceeded'`; report to user |

---

## 7. Measurement Schema

The `measurements` JSONB object shape depends on `data_type`. The complete object is included verbatim in the canonical fingerprint (§5.2). `bytes_per_second`, `items_per_second`, and `unknown_fields` are per-row fields stored inside each row object — not at the case level.

### 7.1 Constraints Common to All `data_type` Values

- `real_time_ns`: IEEE 754 double. Valid range: `(0, 10^15]` (per `docs/BENCHMARK_SPEC.md` §9.10, after unit conversion). Stored as the result of `raw_value × unit_factor` with no further rounding; sub-integer precision is preserved.
- `cpu_time_ns`: IEEE 754 double or JSON `null`. When present, valid range: `(0, 10^15]`.
- `iterations`: positive integer; valid range: `[1, 10^10]`.
- `aggregate_name`: JSON `null` for raw rows; non-empty string ≤ 64 bytes (UTF-8) for aggregate rows. (64-byte limit pending CX-2 to `docs/BENCHMARK_SPEC.md`.)
- `bytes_per_second`: IEEE 754 double or JSON `null`. When present, valid range: `[0, 10^15]` (per `docs/BENCHMARK_SPEC.md` §9.10). Stored verbatim per row; metadata only in MVP — not used for statistical comparison (`docs/BENCHMARK_SPEC.md` §10).
- `items_per_second`: IEEE 754 double or JSON `null`. When present, valid range: `[0, 10^15]` (per `docs/BENCHMARK_SPEC.md` §9.10). Stored verbatim per row; metadata only in MVP.
- `unknown_fields`: JSON object or JSON `null`. Stores any unrecognised fields from the source Google Benchmark JSON row verbatim, without rejection (per `docs/BENCHMARK_SPEC.md` §9.3). Per-row. Object keys are sorted by UTF-16 code unit order (RFC 8785 §3.2.3) in the canonical fingerprint.

**Row-level normalization (required for fingerprint determinism):** All five optional row-level fields (`cpu_time_ns`, `aggregate_name`, `bytes_per_second`, `items_per_second`, `unknown_fields`) must be stored as explicit JSON `null` when the source row provided no value — never omitted. This normalization is applied at write time by both the C++ agent (before SQLite INSERT) and the TypeScript backend (during request body validation). The fingerprint is computed verbatim over this normalized stored form. Two rows that are logically equivalent (no counters, no unknown fields) will always produce the same fingerprint bytes.

- Non-finite numeric values (NaN, ±Infinity) are rejected at the request validation boundary with 400 `VALIDATION_ERROR`. These values are not valid strict JSON but some serializers produce them; validate explicitly.

### 7.2 `raw_samples_available`

`raw_rows` must be non-empty. `aggregate_rows` may be empty.

```json
{
  "raw_rows": [
    {
      "real_time_ns":     100333000.5,
      "cpu_time_ns":      99800000.0,
      "iterations":       1000,
      "aggregate_name":   null,
      "bytes_per_second": 4294967296.5,
      "items_per_second": null,
      "unknown_fields":   null
    }
  ],
  "aggregate_rows": [
    {
      "real_time_ns":     100250000.0,
      "cpu_time_ns":      null,
      "iterations":       1000,
      "aggregate_name":   "mean",
      "bytes_per_second": null,
      "items_per_second": null,
      "unknown_fields":   null
    }
  ]
}
```

### 7.3 `aggregate_only`

`raw_rows` must be empty. `aggregate_rows` must be non-empty. Every aggregate row must have a non-empty `aggregate_name`.

```json
{
  "raw_rows": [],
  "aggregate_rows": [
    {
      "real_time_ns":     125000000.0,
      "cpu_time_ns":      null,
      "iterations":       1000,
      "aggregate_name":   "mean",
      "bytes_per_second": null,
      "items_per_second": null,
      "unknown_fields":   null
    }
  ]
}
```

### 7.4 `no_measurements`

Both arrays must be empty.

```json
{
  "raw_rows": [],
  "aggregate_rows": []
}
```

### 7.5 Per-Row Counter Fields

`bytes_per_second` and `items_per_second` are optional fields from the Google Benchmark JSON row (per `docs/BENCHMARK_SPEC.md` §9.3). They are stored as IEEE 754 doubles inside each row object — not as a case-level sub-object. Storing them per-row preserves their association with the specific repetition's timing. They are metadata-only in MVP and are not used for statistical comparison (`docs/BENCHMARK_SPEC.md` §10).

Both fields are always written to storage explicitly. A field absent in the source row is written as JSON `null`, not omitted (see normalization rule in §7.1).

```json
{
  "real_time_ns":     100333000.5,
  "cpu_time_ns":      99800000.0,
  "iterations":       1000,
  "aggregate_name":   null,
  "bytes_per_second": 4294967296.5,
  "items_per_second": null,
  "unknown_fields":   null
}
```

### 7.6 Unknown Fields

`unknown_fields` is a per-row JSON object storing any unrecognised fields from the source Google Benchmark JSON row verbatim (per `docs/BENCHMARK_SPEC.md` §9.3). The backend must preserve them without rejection. They are included in the canonical fingerprint.

When no unrecognised fields were present in the source row, `"unknown_fields": null` must be written to storage explicitly (see normalization rule in §7.1). The fingerprint is computed over this stored null value; the key is always present in the serialized row.

**Key ordering in the fingerprint:** `unknown_fields` keys are sorted by UTF-16 code unit order (RFC 8785 §3.2.3), consistent with all other object keys. If user-supplied keys contain supplementary-plane characters (U+10000+), their UTF-16 high surrogates sort before BMP characters above U+D7FF — see §5.4 and CT-RFC8785-04 in §5.8.

Example row with unknown fields:

```json
{
  "real_time_ns":     100333000.5,
  "cpu_time_ns":      99800000.0,
  "iterations":       1000,
  "aggregate_name":   null,
  "bytes_per_second": 4294967296.5,
  "items_per_second": null,
  "unknown_fields": {
    "custom_counter": 42,
    "some_label": "value"
  }
}
```

---

## 8. Request and Record Limits

| Limit | Value | Source | Notes |
|---|---|---|---|
| POST /api/v1/runs body | 25 MiB (provisional) | `docs/SECURITY.md` §9.2 | See CONTRADICTION-6 in §12 |
| All other endpoint bodies | 1 MiB | `docs/SECURITY.md` §9.2 | |
| Import file size | 50 MiB | `docs/BENCHMARK_SPEC.md` §9.2 | Independent of submission body limit |
| Benchmark cases per session | 10,000 | `docs/SECURITY.md` §8.2 | Count of items in `benchmarks` array |
| `run_name` byte length | ≤ 1,024 bytes (UTF-8) | Pending CX-2 | Session-level field |
| `canonical_name` byte length | ≤ 1,024 bytes (UTF-8) | `docs/BENCHMARK_SPEC.md` §8.4 | Per-case benchmark identifier |
| `aggregate_name` byte length | ≤ 64 bytes (UTF-8) | Pending CX-2 | Per-row field within measurements |
| `session_id` format | UUID v4 | `ARCHITECTURE.md` §7 | Agent-generated before local persistence |
| `content_fingerprint` format | 64 lowercase hex chars | §5.6 | |
| `import_timestamp` format | `YYYY-MM-DDTHH:mm:ssZ` | §3.5 | UTC, second precision |

**Import-vs-body gap (CONTRADICTION-6):** A valid 50 MiB import file may produce a normalized POST /api/v1/runs body exceeding the 25 MiB limit. The agent must compute the body size before attempting submission. If the body exceeds the configured limit:

- The session is stored locally with `sync_status = 'pending'` and `sync_reason = 'body_limit_exceeded'`.
- No HTTP request is sent.
- The agent outputs a specific message to stderr: `error: normalized submission for session <uuid> is X MiB, exceeding the backend body limit of Y MiB. Session stored locally; manual resolution required.`
- `sscope status` reports this session as pending with the `body_limit_exceeded` reason.

Neither limit is changed here. Resolving this gap requires explicit authorization — see §12 CONTRADICTION-6.

---

## 9. Comparison Eligibility and Environment Policy

### 9.1 Blocking Conditions

The following conditions are authoritative in `docs/BENCHMARK_SPEC.md` §7.1. A comparison request that triggers any blocking condition returns 422 `COMPARISON_INELIGIBLE`; no analysis is performed.

| Condition | Source |
|---|---|
| Different ISA (e.g., `arm64` vs `x86_64`) | `BENCHMARK_SPEC.md` §7.1 |
| Different OS family (e.g., `"macOS"` vs `"Linux"`) | `BENCHMARK_SPEC.md` §7.1 / §4.1 |
| Debug vs. non-Debug build configuration | `BENCHMARK_SPEC.md` §7.1 / §9.11 |

### 9.2 Missing Critical Execution-Time Fields

**Approved policy — requires amendment CX-BS-1 to `docs/BENCHMARK_SPEC.md`:**

When `isa` or `os_name` is stored as `"unavailable"` on either session (per FR-I-011 edge case: the Google Benchmark JSON `context` block was absent or the field was missing), the ISA or OS family blocking condition cannot be evaluated. In this case:

- The comparison is **ineligible**, not confounded.
- Return 422 `COMPARISON_INELIGIBLE` citing the unavailable field.
- Do not infer ISA or OS compatibility from absent metadata.

Rationale: Statistical comparison without verifiable execution environment compatibility is not analytically meaningful. An unknown ISA is not equivalent to a matching ISA.

This policy is specified here as an API-layer rule and requires formal incorporation into `docs/BENCHMARK_SPEC.md` §7.1 via CX-BS-1 (§12) before the backend comparison implementation proceeds.

### 9.3 Confounding Flags

The following flags and severities are authoritative in `docs/BENCHMARK_SPEC.md` §7.2 and §7.3. A confounded comparison returns 201 with `confounding_factors` populated.

| Difference | Flag | Severity | Source |
|---|---|---|---|
| Same ISA, different CPU model | `cpu_model: mismatch` | Medium | `BENCHMARK_SPEC.md` §7.2 |
| Different physical core count | `core_count: mismatch` | Medium | `BENCHMARK_SPEC.md` §7.2 |
| Different clock speed (> 5%) | `clock_speed: mismatch` | Low | `BENCHMARK_SPEC.md` §7.2 |
| Different memory capacity | `memory: capacity_mismatch` | Low | `BENCHMARK_SPEC.md` §7.2 |
| Different memory speed | `memory: speed_mismatch` | Low | `BENCHMARK_SPEC.md` §7.2 |
| OS major version mismatch | `os_version: major_mismatch` | High | `BENCHMARK_SPEC.md` §7.2 |
| OS minor/patch version mismatch | `os_version: minor_mismatch` | Low | `BENCHMARK_SPEC.md` §7.2 |
| Build config mismatch (non-Debug) | `build_config: mismatch` | Medium | `BENCHMARK_SPEC.md` §7.2 |
| Build config absent on either run | `build_config: unverified` | Medium | `BENCHMARK_SPEC.md` §7.3 |
| `cpu_name = "unavailable"` on either run | `cpu_name: unavailable` | Medium | Proposed — pending CX-BS-2 |

The `cpu_name: unavailable` flag is proposed here and requires formal addition to `docs/BENCHMARK_SPEC.md` §7.2 via CX-BS-2 (§12). It follows the existing pattern for unknown compatibility conditions.

All confounded comparisons are not CI gate eligible by default, per `docs/BENCHMARK_SPEC.md` §6.10.

### 9.4 Mandatory Disclaimer

Any comparison response with a non-empty `confounding_factors` array must include `mandatory_disclaimer` set to the verbatim text from `docs/BENCHMARK_SPEC.md` §4.3:

> **Warning:** One or more confounding factors were detected. Results may not reflect a clean performance comparison. Review confounding details before drawing conclusions. This comparison is not eligible for use as a CI gate without explicit opt-in.

### 9.5 Execution-Time vs Import-Time Environment

Per FR-I-013 (`REQUIREMENTS.md`): comparison eligibility and confounding checks use the **execution-time environment** — the scalar columns `os_name`, `os_version`, `cpu_name`, `isa`, `build_type` on the `sessions` table. These represent the environment in which the benchmark ran:

- For synthetic sessions: captured by the agent at run time.
- For imported sessions: extracted from the Google Benchmark JSON `context` block (FR-I-011). May be `"unavailable"` if the `context` block was absent.

`import_environment` is never used for comparison eligibility. It is display-only, shown on the run detail page to identify the importing machine (FR-I-012, FR-D-009, FR-D-012).

---

## 10. Error Code Catalogue

| Code | HTTP | Meaning |
|---|---|---|
| `VALIDATION_ERROR` | 400 | Missing required field, wrong type, out-of-range value, non-finite numeric |
| `BENCHMARK_LIMIT_EXCEEDED` | 400 | `benchmarks` array length > 10,000 |
| `UNAUTHORIZED` | 401 | Missing or invalid credential |
| `SETUP_TOKEN_INVALID` | 401 | Setup token missing, expired, or already used |
| `FORBIDDEN` | 403 | Valid credential; insufficient scope for this route |
| `NOT_FOUND` | 404 | Resource does not exist |
| `SESSION_CONFLICT` | 409 | `session_id` exists with a different `content_fingerprint` |
| `SETUP_TOKEN_CONSUMED` | 409 | Token consumed at mutex step 5; DB write failed; server restart required |
| `PAYLOAD_TOO_LARGE` | 413 | Request body exceeds configured size limit |
| `FINGERPRINT_MISMATCH` | 422 | Backend-computed fingerprint ≠ `submitted_fingerprint`; session not stored |
| `COMPARISON_INELIGIBLE` | 422 | Blocking condition met; no analysis performed |
| `INTERNAL_ERROR` | 500 | Unexpected server error; safe to retry |
| `SERVICE_UNAVAILABLE` | 503 | Backend temporarily unavailable; retry with exponential backoff |

`VALIDATION_ERROR` and `COMPARISON_INELIGIBLE` responses include a `details` array identifying the specific fields or conditions.

---

## 11. Contract Test Cases

### Registration

**CT-01 — Happy path registration**  
Submit valid setup token, unique device_id, valid platform fields. Expect: 201, `api_key` present, `device_id` returned. Verify: second call with same token → 401 `SETUP_TOKEN_INVALID`.

**CT-02 — Re-registration atomicity**  
Valid setup token, device_id that already has a registration. Expect: 201, new `api_key`. Verify: request with old `api_key` to POST /api/v1/runs → 401.

### Session Submission

**CT-03 — Happy path submission**  
Valid API key, well-formed session, 3 benchmark cases, all measurements valid. Expect: 201, returned `session_id` matches submitted UUID.

**CT-04 — Idempotent retry — identical**  
Same request body and `session_id` as CT-03. Expect: 200, same `session_id`. No duplicate rows in DB.

**CT-05 — Fingerprint conflict**  
Same `session_id` as CT-03, one `real_time_ns` value mutated. Expect: 409 `SESSION_CONFLICT`. Original DB row unchanged.

**CT-06 — Concurrent identical submissions**  
Two simultaneous POST /api/v1/runs with identical body and `session_id`. Expect: one 201, one 200. No 500. No duplicate `sessions` row. No missing `benchmark_cases`.

**CT-07 — Fingerprint mismatch (corruption)**  
Valid session body; `submitted_fingerprint` last hex digit changed to a wrong value. Expect: 422 `FINGERPRINT_MISMATCH`. No row inserted.

**CT-08 — Benchmark record limit**  
`benchmarks` array with 10,001 items. Expect: 400 `BENCHMARK_LIMIT_EXCEEDED`.

**CT-09 — Body size limit**  
POST body exceeding 25 MiB. Expect: 413 `PAYLOAD_TOO_LARGE`. Connection closed before full body is read.

**CT-10 — data_type / measurements inconsistency**  
`data_type: "raw_samples_available"`, `raw_rows: []`. Expect: 400 `VALIDATION_ERROR`, `details` field path `benchmarks[0].measurements.raw_rows`.

**CT-11 — Non-finite measurement value**  
`real_time_ns` value of `null` in a raw row. Expect: 400 `VALIDATION_ERROR`.

**CT-12 — Dashboard session isolation**  
Dashboard session cookie on POST /api/v1/runs. Expect: 403 `FORBIDDEN`.

### Comparisons

**CT-13 — Eligible comparison**  
Two synthetic sessions with identical environment, same ISA, same OS. Expect: 201 with per-metric results, `confounding_factors: []`, no disclaimer.

**CT-14 — Confounded comparison (OS minor version mismatch)**  
Session A: macOS 14.3.0; Session B: macOS 14.6.1. Same ISA, same CPU. Expect: 201 with `confounding_factors` containing `{flag: "os_version: minor_mismatch", severity: "Low"}`, `mandatory_disclaimer` set.

**CT-15 — Blocked comparison (different ISA)**  
Session A: `isa = "arm64"`; Session B: `isa = "x86_64"`. Expect: 422 `COMPARISON_INELIGIBLE`, `details` citing `isa` dimension.

**CT-16 — Ineligible: unavailable ISA**  
Session A: `isa = "unavailable"`; Session B: `isa = "arm64"`. Expect: 422 `COMPARISON_INELIGIBLE`, `details` citing `(isa: unavailable)`.

**CT-17 — Aggregate-only comparison (Tier C)**  
Both sessions have `data_type: "aggregate_only"`. Expect: 201 with `[aggregate_only, descriptive_only]` label, no C1–C5 classification, no t-statistic.

### Fingerprint

**CT-18 — Fingerprint stability across retries**  
Agent stores session, computes fingerprint. Network fails. Agent retries with same SQLite data. Second `submitted_fingerprint` is byte-identical to first. Backend returns 200.

**CT-19 — import_environment in fingerprint**  
Session A: imported on Machine X (cpu_name = "Apple M1"). Session B: identical benchmark data, imported on Machine Y (cpu_name = "Apple M2"). Both have distinct `session_id` values. Expect: different `content_fingerprint` values — correct, because `import_environment` differs.

**CT-20 — Synthetic session: import_environment null in fingerprint**  
Synthetic session with `import_environment: null`. Canonical object F must include `"import_environment": null` explicitly. Fingerprint computed by agent and backend must match.

### Serialization (CT-NUM and CT-RFC8785)

See §5.8 for numeric and Unicode canonicalization test vectors. These must be run against both the TypeScript backend implementation and the C++ agent implementation, with byte-identical hex fingerprint output required.

### Pagination

**CT-21 — Pagination boundary**  
101 sessions in DB. `GET /api/v1/runs?page=2&page_size=50` → `data` array of 50, `total_count: 101`, `total_pages: 3`, `page: 2`. `GET /api/v1/runs?page=3&page_size=50` → 1 item, `total_pages: 3`.

**CT-22 — Empty result set**  
No sessions in DB. `GET /api/v1/runs` → 200, `data: []`, `total_count: 0`, `total_pages: 0`. Not 404.

---

## 12. Pending Cross-Document Amendments

No implementation work that depends on a listed item may proceed until that item is resolved in the target document. Items marked **[HARD BLOCKER]** block all work in their listed scope. Items marked **[SOFT]** do not block unrelated work.

| ID | Target Document | Section | Amendment | Blocks |
|---|---|---|---|---|
| CX-1 | `PROJECT.md` | §5.1 | Add `sscope register --backend <url>` to CLI command list | `ARCHITECTURE.md` §4.1 implementation |
| CX-2 | `docs/BENCHMARK_SPEC.md` | §9.3 | Add `run_name ≤ 1,024 bytes` (session-level) and `aggregate_name ≤ 64 bytes` (per-row) field-length constraints | Body limit confirmation; validation implementation |
| CX-3 | `REQUIREMENTS.md` | FR-D | Add dashboard authentication requirement (password + session cookie per `docs/SECURITY.md` §5.4–§5.5) | Dashboard implementation |
| CX-4 | `REQUIREMENTS.md` | SEC-001, FR-B-003 | Clarify no backend-to-agent remote execution channel in MVP; FR-B-003 does not apply to MVP | Backend implementation scope |
| CX-4b | `PROJECT.md` | §5.3 | Clarify "Remote-triggered operations" is a future constraint, not an MVP capability | As above |
| CX-S-1 | `docs/SECURITY.md` | §5.3 | Add `POST /api/v1/comparisons` to routes accessible by dashboard session | `backend/src/routes/comparisons.ts` authorization |
| CX-S-2 | `docs/SECURITY.md` | §13.2 | Update provenance immutability trigger table name from `runs` to `sessions` | DB migration |
| CX-S-3 | `docs/SECURITY.md` | §12.1 | Add narrowly scoped row permitting `sslmode=disable` for Docker Compose / TCP-loopback-only local development | `docker-compose.yml` and `.env.example` |
| CX-S-4 | `docs/SECURITY.md` | §12.3 | Narrow `sscope_app` grants from `SELECT, INSERT, UPDATE, DELETE ON ALL TABLES` to `SELECT, INSERT` on all tables plus `UPDATE (api_key_hash)` on `devices` only (CONTRADICTION-1) | DB grant migration |
| CX-RM-1 | `REQUIREMENTS.md` | ERR-008 | Update error response shape from flat `error_code` to nested `{"error": {"code": ...}}` per `docs/SECURITY.md` §11.3 | Error handling implementation |
| CX-BS-1 | `docs/BENCHMARK_SPEC.md` | §7.1 | Add rule: `isa = "unavailable"` or `os_name = "unavailable"` on either session → comparison ineligible (not confounded). Do not infer compatibility from absent metadata. **[HARD BLOCKER]** | `POST /api/v1/comparisons` implementation |
| CX-BS-2 | `docs/BENCHMARK_SPEC.md` | §7.2 | Add confounding flag `(cpu_name: unavailable)`, severity Medium, for imported sessions where `cpu_name = "unavailable"` | Comparison confounding logic |
| CX-RM-2 | `REQUIREMENTS.md` | FR-B-009, ERR-005 | Update HTTP status for successful `POST /api/v1/comparisons` from 200 to 201. `REQUIREMENTS.md` FR-B-009 currently specifies 200; this document specifies 201 (new resource created, semantically correct per RFC 9110 §9.3.3). | Comparisons endpoint implementation |

**Open blockers without a fixed target:**

| ID | Description | Blocks |
|---|---|---|
| B-1 (partial) | RFC 8785 C++ implementation: library selection or from-scratch implementation must be validated against §5.8 test vectors before any agent sync code is written. Algorithm is fully specified; implementation is not. **[HARD BLOCKER]** | Agent sync path |
| CONTRADICTION-6 | 50 MiB import-file limit (`docs/BENCHMARK_SPEC.md` §9.2) vs 25 MiB provisional HTTP body limit (`docs/SECURITY.md` §9.2). A valid 50 MiB import can produce a body exceeding the submission limit. Agent-side detection behavior is defined in §8. Resolving this gap requires explicit authorization to: (a) raise the body limit in `docs/SECURITY.md`, (b) lower the file limit in `docs/BENCHMARK_SPEC.md`, or (c) introduce a compression mechanism. Neither limit is changed here. | Any import session that produces a normalized body > 25 MiB cannot sync |

**Amendments applied in this document revision:**

| ID | Description | Applied in |
|---|---|---|
| BD-2 | `import_environment` JSONB column added to PostgreSQL `sessions`; TEXT column in SQLite `sessions`; null for synthetic sessions; included in canonical fingerprint | `ARCHITECTURE.md` §6.1, §6.2; §4.3, §5.2, §5.3 of this document |
| CX-ARCH-1 | `sync_reason TEXT` column added to SQLite `sessions`; populated when `sync_status` remains `'pending'` for a known reason (e.g., `'body_limit_exceeded'`) | `ARCHITECTURE.md` §6.2; §6.5, §8 of this document |
| CX-ARCH-2 | `aggregate_name` removed as a case-level column from both `benchmark_cases` tables; field lives per-row inside the `measurements` JSONB | `ARCHITECTURE.md` §6.1, §6.2; §7 of this document |

---

*This document is authoritative for all MVP API endpoint schemas and the canonical fingerprint algorithm as of 2026-11-01. Changes require explicit approval and must be reflected here before implementation proceeds.*
