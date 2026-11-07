# SiliconScope AI — Product Requirements

**Status:** Draft — Awaiting Review  
**Version:** 0.1  
**License:** Proprietary — All Rights Reserved  
**Last updated:** 2026-10-31  
**Authoritative scope reference:** `PROJECT.md`

---

## 1. Document Purpose, Scope, and Hierarchy

### 1.1 Purpose

This document specifies the complete set of functional, non-functional, security, and usability requirements for the SiliconScope AI MVP. It translates the approved product scope in `PROJECT.md` into testable, assignable requirements with stable identifiers and traceable acceptance criteria.

### 1.2 Relationship to Other Specification Documents

Requirements in this document specify _what_ the system must do. The following documents specify _how_ selected subsystems implement those requirements:

| Document                 | Scope                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PROJECT.md`             | Authoritative product scope, two benchmark categories, approved decisions, open questions                                            |
| `docs/BENCHMARK_SPEC.md` | Synthetic workload definitions, statistical methodology, compatibility policy, import parsing rules (OQ-2, OQ-3, OQ-7, OQ-10, OQ-11) |
| `docs/SECURITY.md`       | Authentication mechanism, TLS configuration, agent-backend security design (OQ-1)                                                    |
| `docs/API_CONTRACTS.md`  | REST API versioning strategy, endpoint schemas, result schema, sync protocol (OQ-5, OQ-9)                                            |
| `ARCHITECTURE.md`        | Local persistence mechanism, sync trigger, backend deployment topology (OQ-6, OQ-8, OQ-9)                                            |

Where a requirement depends on an unresolved open question, the blocker is stated explicitly. A requirement may not be implemented until its blockers are resolved.

### 1.3 Requirement Identifier Conventions

| Prefix | Subsystem                             |
| ------ | ------------------------------------- |
| `FR-A` | Native agent (C++20)                  |
| `FR-C` | CLI interface                         |
| `FR-I` | Google Benchmark JSON import          |
| `FR-P` | Local persistence and synchronization |
| `FR-B` | Backend and API                       |
| `FR-D` | Web dashboard                         |
| `FR-R` | Regression detection and reporting    |
| `NFR`  | Non-functional requirements           |
| `SEC`  | Security requirements                 |
| `ERR`  | Error handling and recovery           |
| `UX`   | Accessibility and usability           |

Identifiers are stable. A requirement once assigned an ID retains that ID for the life of the project. Deprecated requirements are marked **[DEPRECATED]** and not renumbered.

### 1.4 How to Read Acceptance Criteria

Each requirement lists observable, verifiable acceptance criteria. Lines marked **[FAIL]** define conditions under which the requirement is not met. Lines marked **[EDGE]** describe boundary or unusual cases that must be explicitly handled.

### 1.5 Approved Platform Scope

- **macOS:** primary MVP validation target. All requirements in this document are binding on macOS. Acceptance criteria must be verified on macOS.
- **Linux:** second planned target. Linux is deferred until a test environment is available; no MVP requirement carries a Linux verification obligation. Linux API paths referenced in individual requirements (e.g., FR-A-001) are informational — included to guide future implementation without re-analysis — and must not be treated as MVP acceptance requirements. A Linux implementation requirement will not be added unless `PROJECT.md` explicitly authorizes it.
- **Windows:** deferred. Requirements must not assume Windows-only APIs, but platform-specific sections must not structurally prevent future Windows support.

---

## 2. Assumptions and Constraints

**AC-01.** The MVP supports a single authenticated user with a single registered device. The data model must support expansion, but multi-user and multi-device behaviors are not required in the MVP.

**AC-02.** Narrowly scoped, allowlisted remote-triggered synthetic benchmark operations are a permitted architecture. Arbitrary remote shell execution is prohibited. Remote execution of custom user-supplied C++ benchmarks is prohibited.

**AC-03.** Git commit SHAs are always provided explicitly by the user via the `--commit` flag. Automatic SHA detection from the file system is not part of the MVP.

**AC-04.** Local result storage must be persistent across agent restarts and process crashes. In-memory-only storage is not acceptable.

**AC-05.** All statistical methodology, minimum repetition counts, variability thresholds, and classification confidence criteria are deferred to `docs/BENCHMARK_SPEC.md`. This document specifies behavioral requirements only.

**AC-06.** All authentication and TLS configuration details are deferred to `docs/SECURITY.md`. This document specifies security guarantees only.

**AC-07.** All REST API schemas and endpoint contracts are deferred to `docs/API_CONTRACTS.md`. This document specifies endpoint behavior only.

**AC-08.** All workload parameters, warmup strategies, and repetition counts for synthetic workloads are deferred to `docs/BENCHMARK_SPEC.md`.

**AC-09.** The machine running `sscope import` may not be the machine on which an imported benchmark ran. Requirements must not conflate execution-time environment with import-time environment.

**AC-10.** Regression detection uses deterministic statistical analysis only. No LLM is involved in the MVP analysis pipeline.

---

## 3. User Roles and Permissions

**R-01 — Authenticated User.**
The registered user of the local agent and backend. Has full read and write access to all benchmark run records, comparison reports, and configuration stored under their account and device.

**R-02 — Unauthenticated Access.**
Denied. All API requests without valid authentication must be rejected with HTTP 401. No data is accessible without authentication.

**Data model extensibility note.** The schema must support the addition of roles (administrator, read-only viewer, etc.) without requiring a breaking migration of existing records.

---

## 4. End-to-End User Journeys

Full use case narratives are in `PROJECT.md` §3. This section maps each use case to the requirements that implement it.

| Use Case | Title                                | Primary Requirements                                         |
| -------- | ------------------------------------ | ------------------------------------------------------------ |
| UC-1     | Establish synthetic baseline         | FR-A-001–019, FR-C-001–003, FR-D-001–008                     |
| UC-2     | Compare before/after system change   | FR-A-001–019, FR-C-001, FR-C-008, FR-R-001–010, FR-D-013–022 |
| UC-3     | Import Google Benchmark result       | FR-I-001–015, FR-C-004–006, FR-D-001, FR-D-009–012           |
| UC-4     | Compare C++ algorithm across commits | FR-I-001–015, FR-C-008, FR-R-001–010, FR-D-013–023           |
| UC-5     | Investigate a regression             | FR-R-001–010, FR-D-017–022                                   |
| UC-6     | Review history and export report     | FR-D-001–007, FR-D-023, FR-R-009                             |

---

## 5. Functional Requirements — Native Agent

### 5.1 Hardware and OS Discovery

**FR-A-001 — CPU model name discovery**
_Owner: Agent | Traced to: UC-1, UC-2_
On every synthetic benchmark run, the agent must discover and record the CPU model name string as reported by the OS (macOS: `sysctl hw.model` or equivalent; Linux: `/proc/cpuinfo` `model name` field or equivalent [informational — Linux is not an MVP validation target per Section 1.5]).

- The recorded model name is non-empty and matches the expected value on the test machine.
- **[EDGE]** If the model name is unavailable, the field is stored as `"unknown"` and a warning is emitted. The run is not aborted.

**FR-A-002 — CPU core count discovery**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must discover and record both the physical core count and the logical core count (accounting for hyperthreading or SMT).

- Both counts are positive integers; logical count >= physical count.
- **[EDGE]** If only one count is available, the available count is recorded and the other is stored as `"unknown"`.

**FR-A-003 — CPU base frequency discovery**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must discover and record the CPU base frequency in MHz where readable from the OS.

- The recorded frequency is a positive finite number where available.
- **[EDGE]** If the OS does not expose base frequency (e.g., due to power management policies), the field is stored as `"unavailable"` and the run is not aborted.

**FR-A-004 — Memory discovery**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must discover and record total installed physical memory in bytes and available memory at the time measurement begins.

- Total memory > 0; available memory >= 0 and <= total memory.

**FR-A-005 — OS name and version discovery**
_Owner: Agent | Traced to: UC-1, UC-2, UC-5_
The agent must discover and record the OS name and version string (e.g., `macOS 14.6.1`).

- The recorded string is non-empty and matches the actual OS of the machine at run time.

**FR-A-006 — Environment snapshot on every synthetic run**
_Owner: Agent | Traced to: UC-1, UC-2, UC-5, UC-6_
The agent must capture and store a complete environment snapshot (FR-A-001 through FR-A-005 plus a timestamp) with every synthetic benchmark run. The snapshot must be captured before benchmark execution begins.

- All fields are present in the stored run record.
- The snapshot timestamp precedes the first measurement timestamp.

### 5.2 Synthetic Benchmark Execution

**FR-A-007 — CPU computation workload execution**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must execute the CPU computation workloads defined in `docs/BENCHMARK_SPEC.md` (OQ-7), covering integer and floating-point operations. Implementation is blocked on OQ-7.

- The workload executes to completion and produces non-trivial, non-constant measurement results.
- **[FAIL]** A workload that exits silently without recording results fails this requirement.

**FR-A-008 — Memory sequential access workload execution**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must execute sequential read and write memory access workloads targeting both cache-resident and main-memory data sizes. Metrics must include throughput (bytes/second) and latency. Exact parameters are in `docs/BENCHMARK_SPEC.md` (OQ-7). Implementation blocked on OQ-7.

- Throughput and latency are positive finite values with recorded units.

**FR-A-009 — Memory randomized access workload execution**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must execute randomized memory access workloads with the same metric requirements as FR-A-008. The access pattern must be genuinely randomized to prevent hardware prefetcher optimization.

- Anti-optimization safeguards per FR-A-015 are applied to the randomized access workload.
- A deterministic unit test confirms the access sequence is non-constant and non-sequential, validating that the randomization logic produces a genuinely randomized pattern independent of hardware behavior.
- Metric values produced by the workload are positive and finite.
- Methodology-specific correctness tests for this workload are specified in `docs/BENCHMARK_SPEC.md` (OQ-7). Implementation blocked on OQ-7.
- **[EDGE]** If measured latency matches sequential access latency on a specific machine (e.g., due to large caches or aggressive prefetchers), this is not treated as a workload failure. Correctness of the access pattern is validated by the deterministic unit test above, not by a runtime latency comparison.

**FR-A-010 — Multithreaded scaling workload execution**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must execute multithreaded workloads at varying thread counts and record per-thread-count measurements. Thread counts and scaling strategy are defined in `docs/BENCHMARK_SPEC.md` (OQ-7). Implementation blocked on OQ-7.

- Measurements are recorded for each thread count and vary across counts on machines with more than one logical core.

### 5.3 Measurement Quality

**FR-A-011 — Warmup before measurement**
_Owner: Agent | Traced to: UC-1, UC-2_
For every synthetic workload, the agent must execute at least one warmup iteration before recording any measurement. Warmup results must not be included in the stored measurement distribution.

- Stored results contain no warmup observations.
- Agent log confirms warmup completion before measurement began.

**FR-A-012 — Repeated measurements**
_Owner: Agent | Traced to: UC-1, UC-2, UC-5_
The agent must collect repeated independent measurements for each synthetic workload. The minimum repetition count is specified in `docs/BENCHMARK_SPEC.md` (OQ-2). Every individual measurement must be recorded, not only the aggregate. Implementation blocked on OQ-2.

- Stored result contains N individual measurements where N >= the minimum defined in `docs/BENCHMARK_SPEC.md`.
- **[FAIL]** Storing only aggregate statistics for synthetic runs is not acceptable.

**FR-A-013 — Distribution recording**
_Owner: Agent | Traced to: UC-1, UC-2, UC-5_
The stored record for every synthetic run must include the full measurement distribution: minimum, maximum, mean, median, and standard deviation computed from the raw repetitions.

- All five values are present, finite, and mutually consistent (min <= median <= max; stddev >= 0).

**FR-A-014 — Explicit machine-readable units**
_Owner: Agent | Traced to: UC-1, UC-2, UC-6_
Every metric value in a stored result record must be accompanied by an explicit unit identifier from the enumerated set defined in `docs/BENCHMARK_SPEC.md`. Implementation blocked on OQ-7.

- No metric value is stored without a unit.
- **[FAIL]** A unit identifier outside the approved enumeration must be rejected.

### 5.4 Optimization Safeguards

**FR-A-015 — Compiler optimization safeguards**
_Owner: Agent | Traced to: UC-1, UC-2_
Every synthetic benchmark workload must apply documented techniques (e.g., Google Benchmark `DoNotOptimize`, `ClobberMemory`, or equivalent) to prevent the compiler from legally eliminating the measured work.

- Documented assembly review for each workload confirms the measured operations are present. This review is a release gate for the benchmark suite.
- **[FAIL]** A workload producing uniformly zero or constant execution time across hardware types is presumed elided and must not be released.

### 5.5 Agent Local Persistence

**FR-A-016 — Durable local persistence after every run**
_Owner: Agent | Traced to: UC-1, UC-2, UC-5, UC-6_
Every completed synthetic benchmark run must be saved to local persistent storage before the CLI command exits. Persistence must survive agent process termination and machine restart. See FR-P-001.

- After `sscope run` exits 0 and the agent process is terminated, the result is present in local storage on the next agent start.

### 5.6 Backend Submission

**FR-A-017 — Automatic backend submission when connected**
_Owner: Agent | Traced to: UC-1, UC-2_
When backend connectivity is available at the time a run completes, the agent must submit the result to the backend. If submission fails, the result must remain in local storage and submission must be retried according to the policy defined in `ARCHITECTURE.md` (OQ-9).

- After a successful submission, the result is queryable via the backend API.
- The locally stored copy is retained after submission (not deleted).
- **[EDGE]** If connectivity is lost mid-submission, the run result is not lost; the agent retries on next available connectivity.

### 5.7 Platform Adapter Interface

**FR-A-018 — Platform adapter for hardware discovery**
_Owner: Agent | Traced to: UC-1, UC-2_
All OS-specific system information discovery (FR-A-001 through FR-A-005) must be implemented behind a platform adapter interface. The interface is defined once; each supported platform provides a concrete implementation. No platform-specific API call may appear outside a platform adapter implementation file.

- Compilation on macOS uses only the macOS adapter.
- The Linux adapter can be compiled independently without macOS-specific symbols.
- A new platform can be added by adding one new adapter without modifying the core engine.

**FR-A-019 — Offline synthetic run capability**
_Owner: Agent | Traced to: UC-1, UC-2_
The agent must execute a synthetic benchmark run and persist the result locally with no backend connection available. The run must not fail or be aborted due to backend unavailability.

- With the backend process stopped, `sscope run` completes, results are stored locally, and the output indicates offline mode without an error exit code.

---

## 6. Functional Requirements — CLI

**FR-C-001 — `sscope run [suite|workload]`**
_Owner: CLI/Agent | Traced to: UC-1, UC-2_
When invoked without arguments or with a suite or workload identifier, the CLI executes the specified synthetic benchmark workload(s) and displays progress and a result summary to stdout.

- Exits 0 on success; result is persisted locally; summary is printed to stdout.
- **[FAIL]** Exit code must be non-zero on any execution error.
- **[EDGE]** An unrecognized suite or workload identifier causes the CLI to print an error listing available identifiers and exit non-zero.

**FR-C-002 — `sscope run --commit <sha>`**
_Owner: CLI/Agent | Traced to: UC-1, UC-2_
The `--commit` flag accepts a non-empty string and stores it as the Git SHA metadata field on the run record. The CLI must not validate whether the SHA corresponds to any real repository.

- The stored run record contains the provided SHA string verbatim, labeled as "user-supplied."
- **[EDGE]** An empty string argument to `--commit` is rejected; the CLI exits non-zero with an error.

**FR-C-003 — `sscope run` workload selection**
_Owner: CLI/Agent | Traced to: UC-1, UC-2_
The CLI must support running either the full suite (no workload argument) or a named individual workload. Workload identifiers are defined in `docs/BENCHMARK_SPEC.md`.

- `sscope run` with no argument runs the full suite.
- `sscope run <workload-id>` runs only that workload.
- An unrecognized workload ID produces a helpful error listing valid identifiers.

**FR-C-004 — `sscope import <file.json>`**
_Owner: CLI/Import | Traced to: UC-3, UC-4_
The CLI accepts a file path, validates the file as Google Benchmark JSON, captures environment and provenance metadata, and stores the result locally. The import must complete without backend connectivity.

- Exits 0 on success; prints a confirmation including the assigned run ID; result is persisted locally and marked `user-supplied import`.
- **[FAIL]** If the file fails any validation check (FR-I-001 through FR-I-007), the CLI prints a specific actionable error to stderr, makes no write to storage, and exits with code 2.
- **[EDGE]** If the file path does not exist, the CLI exits non-zero immediately with a file-not-found error.

**FR-C-005 — `sscope import --commit <sha>`**
_Owner: CLI/Import | Traced to: UC-3, UC-4_
The `--commit` flag on import behaves identically to FR-C-002 applied to the imported run record. It is optional; the run is valid without it.

- The stored import record includes the provided SHA labeled as "user-supplied."

**FR-C-006 — `sscope import --build-config <descriptor>`**
_Owner: CLI/Import | Traced to: UC-3, UC-4_
The `--build-config` flag accepts a non-empty string (e.g., `release`, `debug`) and stores it as the build configuration descriptor on the import record. It is optional.

- The stored record includes the descriptor verbatim; the field is null when the flag is absent.
- **[EDGE]** A descriptor containing only whitespace is treated as absent (null).

**FR-C-007 — `sscope status`**
_Owner: CLI/Agent | Traced to: UC-1_
Reports: agent version, registered device identity (if registered), backend connectivity status (reachable / unreachable), count of locally stored unsynced results, and the local storage path.

- All fields are present in the output.
- Connectivity status correctly reflects current backend reachability.
- Works with no backend connectivity; shows connectivity as "unreachable" without error exit.

**FR-C-008 — `sscope compare <run-id-a> <run-id-b>`**
_Owner: CLI/Agent | Traced to: UC-2, UC-4, UC-5_
Retrieves the two specified run records, performs a compatibility check, and either returns a comparison result or reports the specific reason eligibility was not met. Offline behavior must be explicitly defined in `ARCHITECTURE.md` (OQ-9) before this command is implemented for offline use.

- Eligible compatible runs: exits 0 and prints a structured summary with classification per metric and any environmental difference flags.
- **[FAIL]** Either run ID not found: exits non-zero with an error identifying which ID was missing.
- **[FAIL]** Ineligible runs: exits with code 4 and prints the specific compatibility dimension that failed.
- **[EDGE]** Eligible but confounded runs: exits 0 and prints the comparison result with a prominent confounding warning.

**FR-C-009 — `sscope list` [PROPOSED SCOPE ADDITION — PENDING PROJECT.MD UPDATE]**
_Owner: CLI/Agent | Traced to: UC-2, UC-4, UC-5, UC-6_

> **Scope note:** This command is not currently specified in `PROJECT.md`. It is required because `sscope compare` requires run IDs that users cannot otherwise discover from the CLI. This is an approved proposed scope addition; it must not be implemented until `PROJECT.md` is updated to include it.

Lists stored run records with their run IDs, benchmark source, benchmark name or suite, date, and Git SHA (if present). Supports filtering by `--source synthetic|import` and result limit via `--limit N`.

- Output is human-readable by default; machine-readable JSON available via `--format json`.
- Run IDs match those accepted by `sscope compare`.
- Works offline against locally stored records.

**FR-C-010 — Exit codes**
_Owner: CLI | Traced to: All_
All CLI commands use only the following exit codes:

- `0`: success.
- `1`: general error (invalid arguments, file not found, unknown workload).
- `2`: validation failure (JSON schema error, import rejection).
- `3`: connectivity error (backend unreachable when required).
- `4`: comparison eligibility failure.

**FR-C-011 — Stdout/stderr separation**
_Owner: CLI | Traced to: All_
Progress messages, results, and structured output go to stdout. Error messages and warnings go to stderr.

- Piping `sscope run` stdout to a file captures only result output; error messages appear only on stderr.

**FR-C-012 — Offline behavior per command**
_Owner: CLI/Agent | Traced to: UC-1, UC-2, UC-3_

- `sscope run`: must work offline (FR-A-019).
- `sscope import`: must work offline (FR-I-001–FR-I-015, FR-P-001).
- `sscope status`: must work offline; shows connectivity as "unreachable."
- `sscope list`: must work offline against locally stored records.
- `sscope compare`: offline behavior is blocked on OQ-9; must emit a clear error if invoked offline before OQ-9 is resolved, rather than returning incorrect results.

---

## 7. Functional Requirements — Google Benchmark JSON Import

**FR-I-001 — JSON schema validation**
_Owner: Import | Traced to: UC-3, UC-4_
The importer must validate that the input file is syntactically valid JSON and conforms to the Google Benchmark JSON output schema before any data is stored. Required and optional fields are specified in `docs/BENCHMARK_SPEC.md` (OQ-11). Implementation blocked on OQ-11.

- A valid Google Benchmark JSON file produced via `--benchmark_format=json` passes validation.
- A file missing required fields is rejected with a specific field-level error message.
- **[FAIL]** A file that is not valid JSON is rejected immediately with an error; no partial parse proceeds.

**FR-I-002 — Required field presence**
_Owner: Import | Traced to: UC-3, UC-4_
Fields designated as required in `docs/BENCHMARK_SPEC.md` (OQ-11) must be present and non-null. Absence of any required field is a validation failure.

- A missing required field produces a rejection error identifying the specific field name.

**FR-I-003 — Numeric value validity**
_Owner: Import | Traced to: UC-3, UC-4, UC-5_
All numeric metric values must be finite (not NaN, not ±Infinity), non-negative, and within the plausible range defined in `docs/BENCHMARK_SPEC.md` (OQ-11). Implementation blocked on OQ-11.

- A file containing NaN, Infinity, or a negative time value is rejected with a specific error identifying the field and offending value.
- **[EDGE]** A metric value of exactly zero is accepted unless the defined range explicitly excludes zero.

**FR-I-004 — File size limit**
_Owner: Import | Traced to: UC-3_
The importer must reject files exceeding a defined maximum size. The maximum is defined in `docs/BENCHMARK_SPEC.md` (OQ-11). Rejection must occur before any file content is parsed. Implementation blocked on OQ-11.

- A file exceeding the limit is rejected with an error stating the limit and the actual file size.
- A file within the limit is not rejected for size reasons alone.

**FR-I-005 — Benchmark name character validation**
_Owner: Import | Traced to: UC-3, UC-4_
All benchmark name strings extracted from the JSON must be validated for structural correctness. The following inputs must be rejected:

- Names containing Unicode control characters (U+0000–U+001F, U+007F), including null bytes, unescaped newlines, and carriage returns.
- Names that are not valid UTF-8.
- Names exceeding the maximum byte length defined in `docs/BENCHMARK_SPEC.md` (OQ-11). The byte-length check is blocked on OQ-11.

All other printable characters are permitted, including characters that appear legitimately in Google Benchmark hierarchical names: `/` (e.g., `BM_Sort/1024`), `|`, `$`, `;`, `<`, `>`, and spaces.

The security guarantee against misuse of benchmark name strings is provided by FR-I-006 (no imported string is ever executed or used as an OS-level path or command) and by defense-in-depth measures including safe output encoding during rendering, parameterized database queries for storage, bounded parsing, and strict separation of untrusted data from executable commands and filesystem paths. FR-I-005 is a structural format check, not a security boundary.

- A name containing a null byte (U+0000) is rejected with a specific error identifying the control character.
- A name containing a non-UTF-8 byte sequence is rejected with a specific error.
- The name `BM_Sort/1024` is accepted.
- The name `$(rm -rf ~)` is accepted by FR-I-005 (all printable characters); FR-I-006 and the defense-in-depth measures listed above guarantee no execution of that string.

**FR-I-006 — No code execution from imported data**
_Owner: Import/Backend | Traced to: UC-3, UC-4, SEC-005_
At no point during import, validation, storage, or subsequent retrieval may any value from the JSON file be executed, evaluated as code, interpreted as an expression, or passed to an OS-level API as a command or file path.

- A JSON file with the benchmark name `"$(rm -rf ~)"` is stored verbatim as a string; no shell execution occurs. This is verified by automated test.
- **[FAIL]** Any code path that passes an imported field value to `exec`, `system`, `popen`, `open` (as a path), or equivalent API fails this requirement.

**FR-I-007 — Supported time and throughput units**
_Owner: Import | Traced to: UC-3, UC-4, UC-6_
Time units and throughput units must be from the enumerated supported set defined in `docs/BENCHMARK_SPEC.md` (OQ-11). Units outside the supported set cause rejection. Implementation blocked on OQ-11.

- A file with time unit `ns` is accepted; a file with an unsupported unit string is rejected with an error identifying the unsupported value.

**FR-I-008 — Raw repetition detection and storage**
_Owner: Import | Traced to: UC-3, UC-4, UC-5_
When the Google Benchmark JSON contains per-repetition raw measurements (present when `--benchmark_repetitions` > 1 is used), the importer must extract and store each individual measurement as the sample distribution for that benchmark case.

- A JSON file generated with `--benchmark_repetitions=10` has 10 individual measurements stored per benchmark case.
- Downstream statistical analysis operates on the full sample distribution.

**FR-I-009 — Aggregate-only detection and labeling**
_Owner: Import | Traced to: UC-3, UC-4, UC-5_
When the JSON contains only aggregate statistics rows (e.g., `mean`, `median`, `stddev` result rows) without raw repetition rows, the result must be stored with a permanent label of `aggregate-only`.

- This label is displayed visibly on the dashboard run detail page.
- Any comparison report involving this result includes a note stating that full statistical analysis may be limited.
- **[FAIL]** An aggregate-only result must never be stored or presented as having a raw sample distribution.

**FR-I-010 — Multiple metrics per benchmark case**
_Owner: Import | Traced to: UC-3, UC-4, UC-5, UC-6_
A single benchmark case may report multiple metrics (e.g., `real_time`, `cpu_time`, user-defined counters). The importer must store all reported metrics. No metric may be silently discarded.

- A benchmark case reporting four metrics has all four stored, each with its name, value, unit, and direction (lower-is-better / higher-is-better per `docs/BENCHMARK_SPEC.md`).

**FR-I-011 — Execution-time environment extraction**
_Owner: Import | Traced to: UC-3, UC-4, UC-5_
The Google Benchmark JSON `context` block (containing fields such as `host_name`, `num_cpus`, `mhz_per_cpu`, `cpu_scaling_enabled`, `library_build_type`) must be extracted and stored as the **execution-time environment** of the imported run. These values were captured when the benchmark binary ran, not when `sscope import` ran.

- The stored run record contains an `execution_environment` subrecord populated from the JSON `context` block.
- Each extracted field is labeled with its source (`json_context`).
- **[EDGE]** If the JSON `context` block is absent or a field within it is missing, affected fields are stored as `"unavailable"`. The import is not rejected solely for an incomplete context block; exact policy in `docs/BENCHMARK_SPEC.md` (OQ-11).

**FR-I-012 — Import-time environment capture**
_Owner: Import | Traced to: UC-3, UC-4_
At the time `sscope import` runs, the agent must capture a hardware and OS snapshot of the **importing machine** (same fields as FR-A-001 through FR-A-005) and store it as a separate `import_environment` record.

- The stored run record contains both `execution_environment` (from JSON) and `import_environment` (from the local machine at import time) as distinct, labeled fields.

**FR-I-013 — Separation and labeling of execution vs. import environments**
_Owner: Import | Traced to: UC-3, UC-4, UC-5_
Execution-time environment (FR-I-011) and import-time environment (FR-I-012) must be stored and displayed as separate labeled fields. Comparison eligibility checks must use the execution-time environment, not the import-time environment. If the two environments differ materially (e.g., different CPU model, different OS), the discrepancy must be surfaced in the dashboard run detail view.

- A run imported on a different machine than where it was benchmarked shows both environments labeled distinctly.
- The comparison eligibility check uses `execution_environment` fields.
- The dashboard run detail page shows a discrepancy notice when the two environments differ in any recorded field.

**FR-I-014 — Provenance metadata recording**
_Owner: Import | Traced to: UC-3, UC-4_
Every imported run record must capture: Git commit SHA (nullable, from `--commit`), build configuration descriptor (nullable, from `--build-config`), benchmark binary name (from JSON `context` or equivalent, stored as an opaque string), import timestamp, and source marker.

- All fields are present in the stored record (nullable fields may be null).
- The binary name is stored as a plain string and is never used as a file path or passed to any OS API.

**FR-I-015 — Source marker permanence**
_Owner: Import | Traced to: UC-3, UC-4, UC-5, UC-6_
Every imported run record must carry a permanent, immutable source marker of `user-supplied import`. This marker must appear in the dashboard run history row, run detail page, and all comparison reports involving this run. No API or UI control may remove or hide it.

- The source marker is present on the stored record and cannot be removed or modified after import.
- It appears in the dashboard and in all exported comparison report JSON files.

---

## 8. Functional Requirements — Local Persistence and Synchronization

**FR-P-001 — Result durability across restart**
_Owner: Agent/Persistence | Traced to: UC-1, UC-2, UC-3_
Every completed run (synthetic or imported) must be saved to local persistent storage before the CLI command exits with code 0. The stored data must survive agent process termination, OS-level SIGKILL, and machine restart.

- After `sscope run` or `sscope import` exits 0, terminating the process and restarting, all stored runs remain queryable via `sscope list`.
- **[FAIL]** Any result lost due to process termination after a 0 exit code is a defect.

**FR-P-002 — Data integrity on partial write**
_Owner: Agent/Persistence | Traced to: UC-1, UC-2, UC-3_
If the agent process is terminated mid-write (e.g., by SIGKILL), local storage must not contain a silently corrupt result record.

- On next agent start after a simulated crash during write, `sscope list` either shows no record for the interrupted run, or shows it as incomplete and flagged; it does not show a corrupt record with silently wrong values.

**FR-P-003 — Persistence mechanism** _(Blocked on OQ-8)_
_Owner: Architecture | Traced to: UC-1, UC-2, UC-3_
The specific persistence mechanism (structured JSON files on disk or embedded SQLite database) must be decided in `ARCHITECTURE.md` before implementation. The chosen mechanism must satisfy FR-P-001 and FR-P-002.

**FR-P-004 — Backend synchronization behavior** _(Blocked on OQ-9)_
_Owner: Architecture | Traced to: UC-1, UC-2, UC-3_
Local result persistence (FR-P-001) is independent of backend availability. A result persisted locally is not lost if the backend is unavailable at the time of collection.

When backend connectivity is available at the time a run completes, the agent submits the result to the backend immediately per FR-A-017.

When connectivity is unavailable or submission fails, the result remains in local storage and submission must be retried when connectivity is restored (per FR-A-017, ERR-002, ERR-003). The exact retry trigger, retry timing, conflict handling, and whether any synchronization step requires explicit user action are deferred to `ARCHITECTURE.md` (OQ-9). No implementation may commit to a specific sync mechanism before OQ-9 is resolved.

**FR-P-005 — Offline comparison behavior** _(Blocked on OQ-9)_
_Owner: Architecture | Traced to: UC-2, UC-4, UC-5_
Whether `sscope compare` operates against locally cached data when the backend is unavailable must be explicitly decided in `ARCHITECTURE.md`. Until resolved, the CLI must emit a clear error if `sscope compare` is attempted offline rather than returning incorrect results.

---

## 9. Functional Requirements — Backend and API

**FR-B-001 — Agent authentication**
_Owner: Backend | Traced to: UC-1, UC-2, UC-3, UC-4_
All API requests from the agent must be authenticated. Unauthenticated requests must be rejected with HTTP 401. The authentication mechanism is defined in `docs/SECURITY.md` (OQ-1). Implementation blocked on OQ-1.

- An unauthenticated request returns HTTP 401 with no data.
- A request with valid credentials returns the expected response.

**FR-B-002 — Device registration**
_Owner: Backend | Traced to: UC-1_
The agent must register the device with the backend before submitting results. The device identity must be stable across agent restarts. The registration mechanism is defined in `docs/SECURITY.md` (OQ-1). Implementation blocked on OQ-1.

- After initial registration, subsequent runs are associated with the registered device identity.

**FR-B-003 — Allowlisted remote-triggered synthetic operations**
_Owner: Backend/Agent | Traced to: AC-02_
The backend may trigger a predefined, enumerated set of synthetic benchmark operations on the registered agent. The allowlist is defined in `docs/SECURITY.md`. All inbound operation requests must be validated against the allowlist before execution.

- A request for an allowlisted synthetic operation is executed.
- A request for any non-allowlisted operation is rejected and logged.
- **[FAIL]** Any request involving arbitrary executable paths, shell commands, or script content must be rejected.

**FR-B-004 — No arbitrary remote execution**
_Owner: Backend/Agent | Traced to: SEC-002, AC-02_
The backend must not provide, and the agent must not accept, any mechanism for arbitrary shell execution, script execution, or filesystem access. Custom C++ benchmark execution via remote jobs is prohibited.

- Verified by security review; no test may demonstrate that arbitrary commands can be remotely executed on the agent.

**FR-B-005 — Synthetic run submission**
_Owner: Backend | Traced to: UC-1, UC-2_
The backend must provide an authenticated endpoint to accept a complete synthetic benchmark run record from the agent. The API schema is defined in `docs/API_CONTRACTS.md`. Implementation blocked on OQ-5.

- A valid run record submitted by an authenticated agent is stored and retrievable via FR-B-008.
- An invalid record (missing required fields, non-finite numerics) is rejected with HTTP 400 and a field-level error response.

**FR-B-006 — Imported run submission**
_Owner: Backend | Traced to: UC-3, UC-4_
The backend must provide an authenticated endpoint to accept a complete imported benchmark run record. The record must include the source marker `user-supplied import`. Schema defined in `docs/API_CONTRACTS.md`. Implementation blocked on OQ-5.

- A valid imported record is stored and retrievable; the source marker is preserved.
- A submitted record with code-like content in a string field is stored as a string, not executed (FR-B-013).

**FR-B-007 — Run history retrieval**
_Owner: Backend | Traced to: UC-5, UC-6_
The backend must provide an authenticated endpoint to retrieve a paginated list of run records, sorted by timestamp descending by default. The endpoint must support filtering by benchmark source (synthetic or import), benchmark name or suite identifier, and date range.

- Filtering by `source=synthetic` returns only synthetic runs.
- A date range filter returns only runs within the range.
- An empty result set returns HTTP 200 with an empty list, not HTTP 404.

**FR-B-008 — Single run retrieval**
_Owner: Backend | Traced to: UC-5, UC-6_
The backend must provide an authenticated endpoint to retrieve the complete record for a single run by its ID, including full measurement distribution or aggregate statistics, both environment snapshots, and all provenance metadata.

- A valid run ID returns the complete record with all fields.
- An unknown run ID returns HTTP 404.

**FR-B-009 — Comparison request**
_Owner: Backend | Traced to: UC-2, UC-4, UC-5_
The backend must provide an authenticated endpoint that accepts two run IDs, performs comparison eligibility checking, executes statistical regression analysis if eligible, and returns a structured comparison result. No LLM is involved.

- Eligible runs return HTTP 201 with per-metric classifications and a summary. **(CX-RM-2 — 2026-11-02: corrected from 200; authoritative status code per `docs/API_CONTRACTS.md §4.6`.)**
- Ineligible runs return HTTP 422 with a body identifying the specific failed compatibility dimension(s).
- A request with a nonexistent run ID returns HTTP 404.

**FR-B-010 — Comparison report retrieval**
_Owner: Backend | Traced to: UC-6_
The backend must provide an authenticated endpoint to retrieve the comparison report for a completed comparison as machine-readable JSON conforming to the structure in FR-R-009.

- The endpoint returns valid JSON with Content-Type `application/json`.
- All required report fields per FR-R-009 are present.

**FR-B-011 — Server-side input validation**
_Owner: Backend | Traced to: SEC-009, UC-3_
All data submitted to the backend must be validated server-side independently of agent-side validation. Server-side validation is a defense-in-depth measure and must not be omitted on the assumption that the agent has already validated.

- A crafted API request bypassing the agent that submits a non-finite numeric value is rejected by the backend with HTTP 400.

**FR-B-012 — API versioning** _(Blocked on OQ-5)_
_Owner: Backend | Traced to: OQ-5_
The REST API must include a version identifier. The versioning strategy and compatibility guarantees are defined in `docs/API_CONTRACTS.md` (OQ-5). Implementation blocked on OQ-5.

**FR-B-013 — No execution of submitted data**
_Owner: Backend | Traced to: SEC-005_
The backend must not execute, evaluate, or interpret any field value from a submitted run record as code, a command, or a file path. All submitted string values are stored as opaque data using parameterized queries or equivalent injection-safe mechanisms.

- A submitted record with a field value containing a SQL injection attempt, a shell command, or a script tag is stored verbatim and does not affect system behavior. Verified by security review.

---

## 10. Functional Requirements — Web Dashboard

### 10.1 Run History Page

**FR-D-001 — Run history table columns**
_Owner: Dashboard | Traced to: UC-1, UC-3, UC-6_
The run history page must display a table with the following columns: Run ID (truncated to a displayable length), Benchmark Source (Synthetic / Imported), Benchmark Name or Suite, Date and Time (local timezone), Git SHA (if present, truncated), and a primary summary metric value (per the definition in `docs/BENCHMARK_SPEC.md`).

- All columns are present; imported runs display benchmark name; synthetic runs display suite or workload name.

**FR-D-002 — Default sort order**
_Owner: Dashboard | Traced to: UC-6_
The default sort order is descending by timestamp (most recent first).

- The first row displayed is the most recently stored run.

**FR-D-003 — Run history filtering**
_Owner: Dashboard | Traced to: UC-6_
Filter controls must be provided for: Benchmark Source (All / Synthetic / Imported), Benchmark Name or Suite (free text search), and Date Range (start date, end date). Filters must be combinable.

- Applying `Source = Synthetic` hides all imported runs.
- Applying a date range hides runs outside it.
- Clearing all filters restores the full list.

**FR-D-004 — Pagination**
_Owner: Dashboard | Traced to: UC-6_
The history page must paginate results with a fixed page size (default suggested: 25 per page). Navigation controls (previous page, next page, page number indicator) and a total result count must be displayed.

- Navigation between pages shows the correct subset of results.
- Total result count reflects active filters.

**FR-D-005 — Empty state**
_Owner: Dashboard | Traced to: UC-1_
When no runs have been stored, the history page must display a meaningful empty state with guidance on how to create the first run (minimum: the command to run the first benchmark).

- The empty state is shown when the result set is empty; the table is not rendered with no rows and no message.

**FR-D-006 — Loading state**
_Owner: Dashboard | Traced to: UC-6_
While history data is being fetched, a visible loading indicator must be shown. The table must not render empty or with stale data without indication.

- A loading indicator is visible before data arrives and disappears when data is displayed.

**FR-D-007 — Error state**
_Owner: Dashboard | Traced to: UC-6_
If the backend is unreachable or returns an error, the history page must display a human-readable error message and a retry action. A blank page or raw error object is not acceptable.

- With the backend stopped, the history page displays an error message and a retry control.

### 10.2 Run Detail Page

**FR-D-008 — Synthetic run detail fields**
_Owner: Dashboard | Traced to: UC-1, UC-2_
The run detail page for a synthetic run must display: run ID, timestamp, workload name and suite, all distribution values per metric (min, max, mean, median, stddev), metric units, Git SHA labeled as "user-supplied" (if present), full hardware snapshot (all FR-A-001 through FR-A-005 fields), and OS snapshot.

- All fields are present and labeled; no field displays as `undefined` or blank without explanation.

**FR-D-009 — Imported run detail fields**
_Owner: Dashboard | Traced to: UC-3, UC-4_
The run detail page for an imported run must display: run ID, import timestamp, benchmark name, all stored metrics with values and units, execution-time environment block labeled "Execution Environment — from Google Benchmark JSON context", import-time environment block labeled "Import Environment — capturing machine at time of import", Git SHA labeled "user-supplied" (if present), build configuration (if present), and source marker.

- Both environment blocks are present and labeled distinctly.
- The source marker `user-supplied import` is visible.

**FR-D-010 — Aggregate-only labeling**
_Owner: Dashboard | Traced to: UC-3, UC-5_
When a run's measurements are aggregate-only (FR-I-009), the run detail page must display a visible notice that raw repetition data is unavailable and that statistical analysis may be limited.

- An aggregate-only run shows the notice; a run with raw repetitions does not.
- The notice is visually distinct (e.g., an info or warning banner), not inline text that could be overlooked.

**FR-D-011 — Provenance warning for imported runs**
_Owner: Dashboard | Traced to: UC-3, UC-4_
Every imported run detail page must display a visible provenance notice stating that the commit SHA and build configuration were user-supplied and have not been verified by the platform.

- The notice is visible on initial page load on a 1920×1080 viewport without scrolling.
- Its text explicitly states that verification did not occur.

**FR-D-012 — Execution vs. import environment discrepancy notice**
_Owner: Dashboard | Traced to: UC-3, UC-4_
When the execution-time environment and the import-time environment differ in any recorded field, the run detail page must display a visible discrepancy notice identifying which fields differ and their values from each source.

- Importing a file on a machine with a different CPU model than the JSON `context` block produces a discrepancy notice listing the differing fields.
- Importing on the same machine produces no discrepancy notice.

### 10.3 Comparison Initiation

**FR-D-013 — Run selection for comparison**
_Owner: Dashboard | Traced to: UC-2, UC-4, UC-5, UC-6_
The dashboard must provide both a direct UI mechanism (e.g., checkboxes on the history table) and a URL-based direct link (`/compare?a=<run-id>&b=<run-id>`) for initiating a comparison between two runs.

- Two runs can be selected from history and a comparison initiated via UI.
- A URL with two valid run IDs loads the comparison directly.

**FR-D-014 — Comparison eligibility pre-check**
_Owner: Dashboard | Traced to: UC-2, UC-4, UC-5_
Before executing statistical analysis, the dashboard must display the result of a compatibility check, identifying whether runs are fully compatible, potentially confounded, or ineligible, with the specific dimension(s) responsible.

- The pre-check result is shown before any analysis is displayed.

**FR-D-015 — Incompatible comparison state**
_Owner: Dashboard | Traced to: UC-5_
When two runs are ineligible for comparison, the dashboard must display a specific explanation identifying which compatibility dimension(s) failed. No statistical analysis is executed or displayed.

- Selecting a synthetic CPU run and an imported memory benchmark run shows an incompatibility message naming the failed dimension, not a comparison result or a generic error.

**FR-D-016 — Confounded comparison state**
_Owner: Dashboard | Traced to: UC-2, UC-5_
When two runs are eligible but their environments differ (OS version, hardware, etc.), the analysis proceeds but a prominent confounding warning is displayed, identifying every differing environmental field and the values from each run. The warning appears before the classification results.

- A comparison across an OS version change shows the analysis result and a warning naming the OS version difference.

### 10.4 Comparison Result Page

**FR-D-017 — Per-metric classification display**
_Owner: Dashboard | Traced to: UC-2, UC-4, UC-5_
The comparison result page must display one classification row per eligible metric. Each row must show: metric name, baseline distribution summary (mean ± stddev or "aggregate-only"), candidate distribution summary, absolute change, percentage change, and the classification label (Regression Detected / Possible Regression / Inconclusive / No Regression Detected).

- A comparison of runs with three metrics shows three classification rows with all required fields.

**FR-D-018 — Evidence-based summary display**
_Owner: Dashboard | Traced to: UC-5_
The comparison result page must display an evidence-based summary generated by the regression engine (FR-R-007). The summary must not be the single worst classification across all metrics; it must reflect the actual pattern of findings. It must be labeled as an automated summary.

- A comparison where one metric shows "Regression Detected" and two show "No Regression Detected" displays a summary accurately describing this mixed result.
- The summary does not claim "Regression Detected" as the headline in this scenario.

**FR-D-019 — Environmental difference flags**
_Owner: Dashboard | Traced to: UC-2, UC-5_
All environmental differences between the two compared runs must be listed on the comparison result page: OS version, CPU model, core counts, memory, and (for imported runs) build configuration.

- All differing fields are listed; identical fields are not flagged.

**FR-D-020 — Provenance limitation notice on comparison**
_Owner: Dashboard | Traced to: UC-4, UC-5_
When either compared run is an imported result, the comparison page must display a notice that commit SHA(s) for imported runs were user-supplied and build provenance was not verified.

- The notice is visible on any comparison involving an imported run.
- It is absent when both runs are synthetic.

**FR-D-021 — Inconclusive/insufficient-data state**
_Owner: Dashboard | Traced to: UC-5_
When the analysis cannot produce a reliable classification for a metric (e.g., aggregate-only input, too few samples), that metric's row must display "Inconclusive" with a specific reason. The page must not present a partial analysis as a complete result.

- A comparison using aggregate-only imports displays "Inconclusive" for affected metric rows with an explanatory note.

**FR-D-022 — Rule-based explanation display**
_Owner: Dashboard | Traced to: UC-5_
The comparison result page must display the plain-language summary from the rule-based explanation layer (FR-R-008), visually separate from the classification table, labeled as an automated summary. It must not use speculative root-cause language and must not reference values not present in the run records.

- The summary is present and labeled.
- It does not contain phrases such as "likely caused by" or "root cause."

### 10.5 Comparison Report Export

**FR-D-023 — JSON comparison report export**
_Owner: Dashboard | Traced to: UC-6_
The dashboard must provide a button to download the comparison report as a machine-readable JSON file conforming to FR-R-009. PDF export is post-MVP.

- Clicking the export button downloads a valid JSON file containing all required fields per FR-R-009.
- The downloaded file is parseable programmatically.
- **[EDGE]** If the comparison result is Inconclusive, the export still succeeds and includes the Inconclusive classification and its reason.
- **[FAIL]** If no comparison has been computed, the export button is disabled or absent; it does not download an empty or partial report.

---

## 11. Functional Requirements — Regression Detection and Reporting

**FR-R-001 — Compatibility check dimensions**
_Owner: Regression Engine | Traced to: UC-2, UC-4, UC-5_
Before executing statistical analysis, the backend must verify all of the following dimensions:

1. Same benchmark identity (per OQ-10).
2. Same metric name and reported units.
3. Consistent metric direction (lower-is-better / higher-is-better per `docs/BENCHMARK_SPEC.md`).
4. Same or equivalent workload or benchmark parameters.
5. Compatible hardware configuration (definition in `docs/BENCHMARK_SPEC.md`).
6. OS compatibility (FR-R-002).
7. For imported results: compatible build configuration where captured (per OQ-11).
8. Compatible sampling methodology (policy for raw vs. aggregate-only mismatch in `docs/BENCHMARK_SPEC.md`).

Failure of any single dimension produces a structured error response identifying the failed dimension by name and the conflicting values. Implementation of dimensions 1, 5, 7, 8 blocked on OQ-10 and OQ-11.

**FR-R-002 — OS version compatibility handling**
_Owner: Regression Engine | Traced to: UC-2, UC-5_
Comparisons between runs within the same OS family but different versions (e.g., macOS 14.3 vs. macOS 14.6) must be permitted when all other compatibility criteria are met. The comparison must be flagged as potentially confounded by the OS version difference (FR-R-003).

Comparisons between different OS families (e.g., macOS vs. Linux) must be blocked as ineligible.

The precise definition of "same OS family" and any additional major-version constraints are specified in `docs/BENCHMARK_SPEC.md` (OQ-3). Implementation blocked on OQ-3.

- A comparison between two runs from the same OS family with differing minor or patch versions proceeds with a confounding flag. Verified by test. Specific version examples used in tests are drawn from `docs/BENCHMARK_SPEC.md` once OQ-3 is resolved.
- A comparison between runs from different OS families is blocked with an eligibility error naming the OS family mismatch. Verified by test.
- **[EDGE]** Comparisons involving major-version differences within the same OS family: the outcome (blocked or flagged with confounding) is determined by the compatibility policy in `docs/BENCHMARK_SPEC.md` (OQ-3). No unconditional guarantee is made here; implementation is blocked on OQ-3.

**FR-R-003 — Confounded comparison flagging**
_Owner: Regression Engine | Traced to: UC-2, UC-5_
Any comparison that proceeds despite environmental differences must include a structured `confounding_factors` field in the result enumerating each differing environment dimension with the value from each run.

- The field is present whenever any environment field differs between the two runs.
- It is absent when all environment fields match.
- It lists every differing field, not only a subset.

**FR-R-004 — Per-metric independent classification**
_Owner: Regression Engine | Traced to: UC-4, UC-5_
The regression analysis must classify each eligible performance metric independently. The classification of one metric must not affect the classification of another.

- A benchmark case with three metrics produces three independent classification results.
- The analysis for metric A operates only on the measurements of metric A from both runs.

**FR-R-005 — Classification tier definitions**
_Owner: Regression Engine | Traced to: UC-5_
The analysis must produce exactly one of the following four classifications per eligible metric:

- **Regression Detected** — the measured change exceeds the significance threshold given observed variability. This is a statistical finding, not a confirmed causal diagnosis.
- **Possible Regression** — a change was observed but does not fully meet the significance threshold; variability or sample size may be limiting.
- **Inconclusive** — a reliable classification cannot be produced. Common causes: insufficient sample count, high variability, aggregate-only data, or missing required fields.
- **No Regression Detected** — the measured values are consistent with the baseline within the expected variability range. This does not prove that no performance regression exists; it means no statistically significant change was detected within the conditions of this comparison. Performance changes outside the measured parameters, below the detection threshold, or attributable to factors not captured in the benchmark configuration may not be detected.

The thresholds, statistical method, and computation details are specified in `docs/BENCHMARK_SPEC.md` (OQ-2). Implementation blocked on OQ-2. This requirement defines the four permitted output values and their meanings only.

**FR-R-006 — Aggregate-only limitation in classification**
_Owner: Regression Engine | Traced to: UC-3, UC-5_
When one or both runs contain only aggregate-only statistics, the classification for affected metrics must be "Inconclusive" if the defined statistical method requires raw repetitions that are unavailable, with a specific machine-readable reason code identifying the limitation.

- A comparison where both runs have only aggregate statistics returns "Inconclusive" for all metrics with reason code identifying aggregate-only limitation.
- The result is returned as HTTP 200, not HTTP 400.

**FR-R-007 — Evidence-based summary across metrics**
_Owner: Regression Engine | Traced to: UC-5_
When multiple metrics are classified, the comparison result must include an evidence-based summary describing the pattern across metrics. The summary must not be computed as the worst-case single metric classification. The summary generation rules must be deterministic and are specified in `docs/BENCHMARK_SPEC.md` (OQ-2). Implementation blocked on OQ-2.

- The same two runs always produce the same summary.
- The summary correctly describes the distribution of findings across metrics.

**FR-R-008 — Rule-based explanation output**
_Owner: Regression Engine | Traced to: UC-5_
The regression engine must generate a plain-language explanation for each comparison containing: what was measured, what changed per metric, any environmental differences present, per-metric classifications, the evidence-based summary, and (for imported results) a provenance limitation statement. The explanation must not speculate about root causes, reference data not in the run records, or use causal attribution language. It must be deterministic for the same inputs.

- The explanation does not contain phrases such as "likely caused by," "root cause," or "probably."
- All cited values appear in the stored run records.
- The same run pair always produces the same explanation.

**FR-R-009 — Comparison report structure**
_Owner: Regression Engine | Traced to: UC-6_
The machine-readable comparison report JSON must contain at minimum:

- Report identifier and generation timestamp.
- Full run record for Run A (baseline).
- Full run record for Run B (candidate).
- Comparison metadata: run IDs, comparison timestamp, eligibility outcome.
- `confounding_factors`: list of differing environment dimensions with values from both runs (empty if none).
- Per-metric results: metric name, baseline distribution summary, candidate distribution summary, absolute change, percentage change, classification label, reason code if Inconclusive.
- Evidence-based summary text.
- Rule-based explanation text.
- Provenance limitations block (if either run is imported): states that SHAs were user-supplied and build provenance was not verified.
- Aggregate-only limitation block (if applicable).

Acceptance: a programmatically parsed report JSON contains all listed fields. For an inconclusive comparison, all fields are present with appropriate values or null.

**FR-R-010 — Provenance disclosures in reports**
_Owner: Regression Engine | Traced to: UC-4, UC-6_
Every comparison report involving at least one imported run must include a structured provenance disclosure: commit SHAs were user-supplied; build provenance was not verified; execution-time environment was extracted from the Google Benchmark JSON context block, not independently verified.

- A report for two imported runs contains the disclosure for both.
- A report for one synthetic and one imported run contains the disclosure only for the imported run.
- A report for two synthetic runs contains no provenance disclosure block.

---

## 12. Security Requirements

**SEC-001 — Agent operation allowlist**
_Owner: Agent | Traced to: AC-02, FR-B-003_
The agent must maintain an explicit enumerated allowlist of synthetic benchmark operation types it will accept from the backend. Every inbound remote request must be validated against the allowlist before any execution. The allowlist is defined in `docs/SECURITY.md`. Requests not on the allowlist must be rejected and logged.

- A backend request for an allowlisted operation is executed.
- A request for any non-allowlisted operation is rejected; an audit log entry is created.

**SEC-002 — No arbitrary remote execution**
_Owner: Agent/Backend | Traced to: FR-B-004_
The agent must not accept any remote instruction involving arbitrary executable paths, shell command strings, evaluated scripts, or dynamically specified binary invocations.

- Verified by security review and by a test that submits a remote operation containing a shell command string and confirms it is rejected at the agent.

**SEC-003 — No remote custom benchmark execution**
_Owner: Agent/Backend | Traced to: PROJECT.md §5.2_
The backend must not provide, and the agent must not expose, any mechanism to remotely trigger the build or execution of a custom C++ benchmark. This applies without exception in the MVP.

- Verified by security review; no code path allows a backend request to cause the agent to run a user-supplied binary.

**SEC-004 — TLS for all agent-backend communication**
_Owner: Agent/Backend | Traced to: FR-B-001_
All network communication between agent and backend must use TLS with certificate validation enforced. Plaintext connections must be rejected. TLS configuration is specified in `docs/SECURITY.md`. Implementation blocked on OQ-1.

- A connection attempt without TLS is rejected.

**SEC-005 — No code execution from imported data**
_Owner: Import/Backend | Traced to: FR-I-006, FR-B-013_
No value in any imported JSON file, API payload, or stored run record may be executed, evaluated as code, or used as an OS-level command or file path. This applies at all layers: CLI, agent, and backend.

- A test suite of crafted inputs (shell injection, path traversal, SQL injection) passes through the full import pipeline; none produces unintended execution or storage corruption.

**SEC-006 — No interpretation of string metadata as commands or paths**
_Owner: Import/Backend | Traced to: FR-I-005, FR-I-006_
String fields in imported results (benchmark names, binary name, build configuration, commit SHA) must be stored and displayed as opaque strings. None may be passed to `exec`, `system`, `popen`, `open` (as a path), or equivalent API.

- Code review confirms no imported string field is used in an OS call.
- Automated tests verify expected string handling.

**SEC-007 — Authentication enforced at every endpoint**
_Owner: Backend | Traced to: FR-B-001_
Every API endpoint that reads, creates, or modifies run records must require valid authentication. This must be enforced at each endpoint individually, not solely through middleware that can be bypassed.

- Every API endpoint has an automated test verifying that an unauthenticated request returns HTTP 401.

**SEC-008 — Provenance label immutability**
_Owner: Import/Backend | Traced to: FR-I-015_
The source marker `user-supplied import` and provenance limitation notices are immutable after storage. No API endpoint or dashboard control may remove, hide, or overwrite these labels.

- No API endpoint modifies the source marker of a stored record.
- The dashboard has no control to hide provenance notices.

**SEC-009 — No credentials in run records**
_Owner: Agent/Backend | Traced to: FR-B-005, FR-B-006_
Run records, comparison reports, and exported JSON must not contain authentication credentials, API keys, private file paths, or other sensitive configuration values.

- An automated scan of a representative set of stored records and exported reports confirms no credential-pattern strings are present.

---

## 13. Error Handling and Recovery

**ERR-001 — Import validation failure**
_Owner: CLI/Import | Traced to: FR-C-004, FR-I-001_
When `sscope import` fails any validation check, the CLI must print a specific, actionable error to stderr identifying the field or rule that failed, exit with code 2, and make no write to local storage.

- An invalid JSON file produces a named-field error message.
- `sscope list` shows no new record after a failed import.
- The error message states what was wrong and how to correct it.

**ERR-002 — Backend connectivity loss during synthetic run**
_Owner: Agent | Traced to: FR-A-017, FR-A-019_
If backend connectivity is lost during or after a synthetic benchmark run, the run is persisted locally, the CLI exits with code 0, and a non-error message informs the user that the result is stored locally and will be synced when connectivity is restored.

- With the backend stopped, `sscope run` exits 0 and the result is in local storage.

**ERR-003 — Backend connectivity loss during import**
_Owner: CLI/Import | Traced to: FR-C-004_
If backend connectivity is unavailable during import, the result is persisted locally, the CLI exits with code 0, and a non-error message notes local-only storage.

- With the backend stopped, `sscope import` exits 0 and the result is in local storage.

**ERR-004 — Local storage corruption**
_Owner: Agent/Persistence | Traced to: FR-P-002_
If the agent detects corrupted or unreadable local storage on startup, it must report the condition via `sscope status` rather than silently operating on incomplete data. It must not overwrite potentially recoverable data without explicit user action.

- `sscope status` with deliberately corrupted storage reports the corruption condition.
- The agent does not automatically delete the corrupted store.

**ERR-005 — Comparison with insufficient data**
_Owner: Regression Engine | Traced to: FR-R-005, FR-R-006_
When the regression engine cannot classify a metric due to insufficient data, it returns HTTP 200 with an "Inconclusive" classification and a specific machine-readable reason code. This is not treated as an HTTP error.

- A comparison between two aggregate-only runs returns HTTP 200 with "Inconclusive" and a reason code, not HTTP 400 or HTTP 422.

**ERR-006 — Comparison with ineligible runs**
_Owner: Backend | Traced to: FR-R-001_
When two runs are ineligible for comparison, the backend returns HTTP 422 with a structured body identifying the specific failed compatibility dimension(s). No analysis is performed.

- Comparing a synthetic CPU run and an imported memory benchmark returns HTTP 422 naming the failed compatibility dimension.

**ERR-007 — Invalid or oversized import file**
_Owner: CLI/Import | Traced to: FR-I-001, FR-I-004_
File-level errors produce distinct, specific error messages:

- Non-JSON file: error states "not valid JSON."
- Oversized file: error states "exceeds maximum file size of X."
- Unreadable file: error states that the file could not be read and why.
  All produce exit code 2.

**ERR-008 — Backend API error format**
_Owner: Backend | Traced to: FR-B-005_
All 4xx and 5xx responses from the API must return JSON in the envelope structure defined in `docs/API_CONTRACTS.md §3.1`: `{"error": {"code": "<stable string>", "message": "<human-readable>"}}`. The `code` field is the stable machine-readable identifier (e.g., `"VALIDATION_ERROR"`); the `message` field is human-readable. **(CX-RM-1 — 2026-11-02: clarified envelope structure as nested `{"error": {...}}` per `API_CONTRACTS.md §3.1`; prior wording implied a flat `error_code` top-level field.)**

- Every error response from the API passes a schema check for the `error.code` and `error.message` fields.

**ERR-009 — Dashboard graceful error states**
_Owner: Dashboard | Traced to: FR-D-007_
Every dashboard page that fetches remote data must handle loading, error (backend unreachable or request failed), and empty (successful fetch, no data) states explicitly. None of these states may produce a blank page or an unhandled JavaScript exception visible to the user.

- With the backend stopped, all dashboard pages display a graceful error state with a retry option.

---

## 14. Accessibility and Usability

The dashboard targets WCAG 2.1 Level AA. Requirements below are testable targets. Full WCAG 2.1 AA compliance is not claimed until independently verified.

**UX-001 — Keyboard navigability of core flows**
_Owner: Dashboard | Traced to: All FR-D_
All primary dashboard flows — run history browsing, run detail viewing, comparison initiation, and JSON report export — must be fully operable using a keyboard alone.

- Using only Tab, Shift+Tab, Enter, Space, and arrow keys, a user can: navigate the run history, open a run detail, select two runs and initiate a comparison, and trigger the JSON export.

**UX-002 — Color contrast**
_Owner: Dashboard | Traced to: All FR-D_
All text and interactive elements must meet WCAG 2.1 AA color contrast ratios: 4.5:1 for normal text, 3:1 for large text and UI components.

- Automated contrast checking tools (e.g., axe-core, Lighthouse) report no contrast failures.

**UX-003 — ARIA labels on interactive elements**
_Owner: Dashboard | Traced to: All FR-D_
All interactive elements (buttons, filter controls, pagination controls, export trigger) must have descriptive ARIA labels or associated visible labels.

- Automated accessibility audit reports no missing-label violations.

**UX-004 — Screen reader compatibility for comparison results**
_Owner: Dashboard | Traced to: FR-D-017, FR-D-022_
The comparison result table must use semantic `<table>` elements with `<th>` headers and `scope` attributes. Classifications and summaries must be accessible to screen readers.

- Tested with VoiceOver (macOS); the comparison result table is announced with correct column and row context.

**UX-005 — No color-only information encoding**
_Owner: Dashboard | Traced to: FR-D-017, FR-D-016_
Statistical classification labels and confounding warnings must not communicate meaning through color alone. A text label, icon, or pattern must accompany any color-coded indicator.

- Viewing the comparison result page in grayscale simulation conveys the same classification information as in full color.

**UX-006 — CLI error message quality**
_Owner: CLI | Traced to: ERR-001 through ERR-009_
All CLI error messages must be actionable: they must state what went wrong and what the user can do to resolve it. Generic "Error" messages with no context are not acceptable.

- A representative set of error-triggering inputs produces messages that each include a specific cause and a corrective suggestion.

**UX-007 — Provenance and limitation notices are visible without scrolling**
_Owner: Dashboard | Traced to: FR-D-011, FR-D-020_
Provenance limitation notices on imported run detail pages and comparison pages must be visible on initial page load on a standard 1920×1080 viewport without scrolling. They must not be hidden in collapsed accordions by default.

- On a 1920×1080 viewport, provenance notices on run detail and comparison pages are visible without scrolling.

**UX-008 — Aggregate-only and confounded warnings are visually distinct**
_Owner: Dashboard | Traced to: FR-D-010, FR-D-016_
Aggregate-only labels and confounded comparison warnings must be visually distinguishable from each other and from regular content (e.g., using different banner styles or icons).

- A page showing both an aggregate-only notice and a confounding warning allows a user to visually distinguish the two at a glance.

---

## 15. Non-Functional Requirements

**NFR-001 — CLI response time**
_Owner: Agent/CLI | Traced to: All FR-C_
`sscope status` must return within 2 seconds when the backend is reachable and within 500ms when offline. `sscope import` must complete validation and local storage within 5 seconds for a file within the approved size limit. `sscope run` response time is dominated by benchmark execution time and is not bounded independently here.

- Measured on the macOS reference test machine under normal operating conditions.

**NFR-002 — API response time targets**
_Owner: Backend | Traced to: FR-B-005 through FR-B-010_
Run submission endpoints respond within 1 second under normal load. Run history and single-run retrieval respond within 500ms for a history of up to 1,000 runs. Comparison requests respond within 5 seconds. These targets apply to the local development deployment.

- Measured with a representative dataset using a local backend instance.

**NFR-003 — Dashboard load time**
_Owner: Dashboard | Traced to: FR-D-001_
The run history page must display data within 3 seconds of initial navigation on a standard development machine with a local backend.

- Measured via browser developer tools; time to first meaningful content < 3 seconds.

**NFR-004 — Local storage durability**
_Owner: Agent/Persistence | Traced to: FR-P-001_
All locally stored results must survive process termination, OS restart, and file system errors recoverable by the OS. This is a correctness requirement.

- Verified by the FR-P-001 acceptance scenario.

**NFR-005 — Data integrity**
_Owner: All | Traced to: FR-P-002_
No silent data corruption may occur during result storage, retrieval, or export. Any corruption must be detected and reported rather than silently propagated.

- A checksum or equivalent integrity check is implemented at the storage layer; corruption introduced by test tooling is detected on read.

**NFR-006 — Platform portability**
_Owner: Agent | Traced to: FR-A-018_
The C++20 agent must compile and pass all tests on macOS. The platform adapter interface must structurally allow Linux to be added without modifying the core engine. Portability is a design requirement even before Linux support is tested.

- No `#ifdef __APPLE__` or equivalent OS-specific directive appears outside platform adapter implementation files.
- The project build system can compile the Linux adapter independently of macOS.

**NFR-007 — Subsystem independence**
_Owner: All | Traced to: All_
The agent, import pipeline, regression engine, backend API, and dashboard must be independently testable units with defined interface boundaries. No circular dependencies across subsystems are permitted.

- Each subsystem has unit tests that run without instantiating other subsystems.

**NFR-008 — Full requirement testability**
_Owner: All | Traced to: Section 16_
Every functional requirement in this document must have at least one automated test case. Security requirements must have dedicated tests for the threat scenarios they address. Statistical classification requirements must be tested against known inputs with expected outputs determined from `docs/BENCHMARK_SPEC.md`.

- Test coverage tooling confirms every FR, SEC, and ERR identifier is referenced by at least one test.

---

## 16. Acceptance Criteria and Test Traceability

### 16.1 Traceability Matrix

| Requirement Range   | UC-1 | UC-2 | UC-3 | UC-4 | UC-5 | UC-6 |
| ------------------- | :--: | :--: | :--: | :--: | :--: | :--: |
| FR-A-001–019        |  ✓   |  ✓   |      |      |      |      |
| FR-C-001–003        |  ✓   |  ✓   |      |      |      |      |
| FR-C-004–006        |      |      |  ✓   |  ✓   |      |      |
| FR-C-007            |  ✓   |      |      |      |      |      |
| FR-C-008            |      |  ✓   |      |  ✓   |  ✓   |      |
| FR-C-009 (proposed) |      |  ✓   |      |  ✓   |  ✓   |  ✓   |
| FR-I-001–015        |      |      |  ✓   |  ✓   |      |      |
| FR-P-001–005        |  ✓   |  ✓   |  ✓   |      |      |      |
| FR-B-001–013        |  ✓   |  ✓   |  ✓   |  ✓   |  ✓   |  ✓   |
| FR-D-001–007        |  ✓   |      |  ✓   |      |      |  ✓   |
| FR-D-008            |  ✓   |  ✓   |      |      |      |      |
| FR-D-009–012        |      |      |  ✓   |  ✓   |      |      |
| FR-D-013–016        |      |  ✓   |      |  ✓   |  ✓   |      |
| FR-D-017–022        |      |  ✓   |      |  ✓   |  ✓   |      |
| FR-D-023            |      |      |      |      |      |  ✓   |
| FR-R-001–010        |      |  ✓   |      |  ✓   |  ✓   |  ✓   |

### 16.2 Test Categories

- **Unit tests.** Per-function correctness within a single subsystem. FR-I, FR-R, and FR-A requirements each require unit tests. The JSON importer (FR-I-001 through FR-I-007) must be tested against a malformed-input corpus.
- **Integration tests.** Cross-subsystem correctness. Agent → local storage → backend submission → API retrieval must be tested end-to-end for UC-1 and UC-3.
- **End-to-end tests.** Full user journey from CLI command to dashboard state, covering UC-1 through UC-6. Must exercise all four comparison classification tiers.
- **Security tests.** Dedicated tests for SEC-001 through SEC-009, including shell injection attempts via import, allowlist bypass attempts, and no-execution verification.
- **Accessibility tests.** Automated WCAG 2.1 AA audit via axe-core or equivalent, run as part of dashboard CI for every build.

### 16.3 Key Edge Case Test Scenarios

| Scenario                                                                                                          | Requirements verified                  |
| ----------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `sscope run` with backend stopped                                                                                 | FR-A-019, FR-P-001, ERR-002            |
| `sscope import` with backend stopped                                                                              | FR-C-004, FR-P-001, ERR-003            |
| Import aggregate-only Google Benchmark JSON                                                                       | FR-I-009, FR-R-006, FR-D-010, FR-D-021 |
| Import on Machine B a file benchmarked on Machine A                                                               | FR-I-011, FR-I-012, FR-I-013, FR-D-012 |
| Compare runs with OS version difference                                                                           | FR-R-002, FR-R-003, FR-D-016           |
| Compare synthetic CPU run vs. imported memory run                                                                 | FR-R-001, ERR-006, FR-D-015            |
| Import JSON with injection string in benchmark name (e.g., `$(rm -rf ~)`) — must be stored verbatim, not executed | FR-I-005, FR-I-006, SEC-005, SEC-006   |
| Import JSON with NaN metric value                                                                                 | FR-I-003, ERR-007                      |
| Import JSON exceeding file size limit                                                                             | FR-I-004, ERR-007                      |
| Compare two runs producing each of the four classification tiers                                                  | FR-R-005, FR-D-017                     |
| Export comparison report for Inconclusive result                                                                  | FR-D-023, FR-R-009                     |
| Dashboard: history page with no stored runs                                                                       | FR-D-005                               |
| Dashboard: backend unreachable                                                                                    | FR-D-007, ERR-009                      |
| Process SIGKILL during local write                                                                                | FR-P-002, ERR-004                      |

---

## 17. Explicit Exclusions and Deferred Features

The following must not be implemented, partially implemented, or stubbed in a way that implies availability in the MVP.

| Feature                                                      | Deferral horizon                                    |
| ------------------------------------------------------------ | --------------------------------------------------- |
| Automatic Git commit SHA detection                           | Post-MVP (near-term)                                |
| Linux platform support                                       | Post-MVP (pending test environment)                 |
| Windows support                                              | Long-term                                           |
| CI/CD pipeline integration                                   | Post-MVP (medium-term)                              |
| Verified build provenance                                    | Post-MVP (medium-term)                              |
| Automated build orchestration for custom benchmarks          | Post-MVP (requires verified build provenance first) |
| Remote execution of custom C++ benchmarks                    | Post-MVP (requires separate security design)        |
| Multi-device support                                         | Post-MVP (medium-term)                              |
| Multi-user / multi-tenant support                            | Long-term                                           |
| LLM-powered diagnostics                                      | Post-MVP (medium-term, opt-in)                      |
| GPU benchmarks                                               | Long-term                                           |
| Profiling integration                                        | Long-term                                           |
| Extended workload integration (non-Google-Benchmark formats) | Long-term                                           |
| PDF comparison report export                                 | Post-MVP (near-term)                                |
| `sscope list` CLI command                                    | Proposed addition — blocked on `PROJECT.md` update  |

---

## 18. Open Decisions and Implementation Blockers

No implementation work that depends on a listed blocker may begin until the blocker is resolved in the designated document.

| ID    | Question                                                                                                                                                               | Blocks                                                            | Resolve In               |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------ |
| OQ-1  | Authentication mechanism for agent registration and API access                                                                                                         | FR-B-001, FR-B-002, SEC-004, SEC-007, all authenticated endpoints | `docs/SECURITY.md`       |
| OQ-2  | Statistical method, minimum sample sizes, variability thresholds, classification thresholds, summary generation rules                                                  | FR-A-012, FR-R-005, FR-R-007, NFR-008                             | `docs/BENCHMARK_SPEC.md` |
| OQ-3  | Minimum supported OS versions and OS-family definition for compatibility                                                                                               | FR-A-001–005, FR-R-002                                            | `docs/BENCHMARK_SPEC.md` |
| OQ-4  | Agent distribution and installation method                                                                                                                             | Deployment documentation, FR-A-019 setup                          | `ARCHITECTURE.md`        |
| OQ-5  | Benchmark result schema versioning and compatibility strategy                                                                                                          | FR-B-012, API evolution, FR-B-005, FR-B-006                       | `docs/API_CONTRACTS.md`  |
| OQ-6  | Backend deployment topology (local development vs. hosted production)                                                                                                  | FR-B-001, SEC-004, NFR-002                                        | `ARCHITECTURE.md`        |
| OQ-7  | Exact workload parameters for each synthetic benchmark (data sizes, thread counts, iteration strategies)                                                               | FR-A-007–010, FR-A-012–014, FR-C-003                              | `docs/BENCHMARK_SPEC.md` |
| OQ-8  | Local persistence mechanism (structured JSON files vs. embedded SQLite)                                                                                                | FR-P-001–003                                                      | `ARCHITECTURE.md`        |
| OQ-9  | Synchronization trigger, conflict handling strategy, offline `sscope compare` behavior                                                                                 | FR-P-004–005, FR-C-008, FR-C-012                                  | `ARCHITECTURE.md`        |
| OQ-10 | Custom benchmark identity scheme (name matching, user-assigned ID, or structured descriptor)                                                                           | FR-R-001, FR-I-001, FR-D-013                                      | `docs/BENCHMARK_SPEC.md` |
| OQ-11 | Google Benchmark JSON parsing rules: required fields, repetition detection, aggregate handling, numeric range limits, file size limit, build config eligibility fields | FR-I-001–015, FR-R-006, FR-I-004                                  | `docs/BENCHMARK_SPEC.md` |

### 18.1 Subsystem Implementation Dependency Order

1. `docs/SECURITY.md` (OQ-1) → must be resolved before any agent-backend communication code is written.
2. `docs/BENCHMARK_SPEC.md` (OQ-7, OQ-11) → must be resolved before synthetic workloads or the JSON importer are implemented.
3. `ARCHITECTURE.md` (OQ-8) → must be resolved before any local persistence code is written.
4. `docs/API_CONTRACTS.md` (OQ-5) → must be resolved before backend API endpoints are implemented.
5. `docs/BENCHMARK_SPEC.md` (OQ-2, OQ-10) → must be resolved before the regression detection engine is implemented.
6. `PROJECT.md` update → must occur before FR-C-009 (`sscope list`) is implemented.

---

_This document translates the approved product scope in `PROJECT.md` into testable requirements. Scope changes require explicit approval and must be reflected in `PROJECT.md` first. Requirement IDs are stable; deprecated requirements are marked [DEPRECATED] rather than renumbered._
