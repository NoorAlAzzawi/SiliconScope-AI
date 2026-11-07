# SiliconScope AI — Project Document

**Status:** Planning  
**License:** Proprietary — All Rights Reserved  
**Last updated:** 2026-10-31

---

## 1. Project Overview

SiliconScope AI is an open-source platform for hardware-aware performance benchmarking, software performance validation, regression detection, and evidence-based analysis. It consists of a native C++20 benchmarking agent that runs locally on a developer's machine, a hosted web backend that stores and processes results, and a web dashboard for exploring benchmark history, comparing runs, and reviewing regression reports.

The platform supports two distinct benchmark categories, which share common storage, comparison, and dashboard infrastructure but differ in how they produce data, what their results mean, and what security rules govern them:

- **Synthetic Benchmarks** — built-in C++20 workloads that measure machine-level performance: CPU computation throughput, memory access characteristics, and multithreaded scaling. These workloads execute under defined, reproducible conditions. They do not run user application code and do not directly measure the performance of a developer's software.

- **Custom C++ Benchmark Integration** — a structured import capability that allows developers to run their own [Google Benchmark](https://github.com/google/benchmark)-based C++ benchmarks locally, export the results as JSON, and import them into SiliconScope AI. This enables storage, historical tracking, and regression analysis of application-level performance measurements while keeping all benchmark execution under the developer's direct control.

SiliconScope AI's core technical identity rests on four properties:

- **Reproducibility.** Every benchmark run is defined precisely: workload parameters, warmup strategy, repetition count, and environment capture. Results are reproducible within the statistical variability of the host system.
- **Environment awareness.** Results are tagged with the hardware profile and OS context of the machine that produced them. Comparisons are only valid between compatible environments.
- **Evidence-based reporting.** Regression detection uses deterministic statistical analysis. Findings are classified by confidence level and accompanied by the measurements that support them.
- **Git-linked history.** Benchmark runs can be associated with explicit Git commit SHAs, enabling engineers to correlate machine performance measurements and application benchmark results with specific points in their software development history.

---

## 2. Target Users

### Primary Users

**Performance engineers and systems software engineers** who need a structured, reproducible way to measure, store, and compare performance results across time and system configurations. This includes both characterizing machine-level performance using synthetic workloads and tracking the performance of their own C++ code across software versions. They are comfortable with the command line, understand measurement variability, and require defensible data rather than approximate indicators.

**Hardware validation engineers** who need a repeatable synthetic workload suite to characterize the computational and memory performance of a machine, independent of application-level software.

### Secondary Users

**C++ developers** who use Google Benchmark to measure the performance of their own functions or algorithms and want a structured workflow for storing, comparing, and tracking those results over time. In the MVP, they build and run their benchmarks locally using their own toolchain, then import the structured JSON output into SiliconScope AI for historical storage and regression analysis.

### Out of Scope for MVP

Research teams running large-scale multi-machine benchmarking studies, CI systems requiring automated benchmark gating, and end users without engineering context are not primary targets for the MVP. They may be addressed in later phases.

---

## 3. Use Cases

The following are concrete, representative workflows that SiliconScope AI must support. Each use case identifies the applicable benchmark category.

**UC-1: Establish a synthetic performance baseline on a machine.**
_Category: Synthetic._
An engineer sets up a new development workstation and wants to record its baseline CPU and memory performance. They install the agent, run the full synthetic benchmark suite, and view the detailed results on the dashboard. The run is annotated with the current date and, optionally, the Git SHA of the project they are working on as contextual metadata — not as a claim that the synthetic benchmarks measured any application code. The result becomes the documented performance baseline for that machine and configuration.

**UC-2: Compare machine-level performance before and after a system change.**
_Category: Synthetic._
An engineer is preparing to upgrade their operating system. Before the upgrade, they run the full benchmark suite and store the result. After the upgrade, they run the suite again and request a comparison. The platform checks that both runs are compatible (same hardware, same workload configuration), performs a statistical analysis, and reports whether measured performance changed, by how much, and with what confidence. Any environmental differences between the two run records are surfaced alongside the result. The platform does not assert a root cause.

**UC-3: Import a Google Benchmark result from a locally executed C++ benchmark.**
_Category: Custom C++ Benchmark Integration._
An engineer has written a Google Benchmark test for a sorting algorithm in their C++ project. They build and run the benchmark binary on their development machine using their normal toolchain. The binary produces a JSON output file. They run `sscope import result.json --commit abc1234 --build-config release` to import the result into SiliconScope AI. The CLI validates the JSON against the required schema, records the benchmark identity, measurement data, and provenance metadata, captures an environment snapshot from the local machine, and stores the result marked as `user-supplied import`. The result appears in the dashboard alongside synthetic benchmark runs. No code in the JSON file is executed at any point.

**UC-4: Compare C++ algorithm performance across two identified software versions.**
_Category: Custom C++ Benchmark Integration._
An engineer has been optimizing a sorting algorithm and wants to measure whether their changes improved performance. After each significant change, they build and run the benchmark binary, export the JSON, and import it with the corresponding Git commit SHA. On the dashboard, they select two stored runs from different commits and request a comparison. The platform checks comparison eligibility: same benchmark identity, same metric, same units, same workload parameters, compatible build configuration, and compatible environment. If eligible, it performs a statistical analysis and reports a regression classification. The comparison report states that the commit SHAs were user-supplied and that the platform did not verify that the binary was built from those revisions.

**UC-5: Investigate a detected or possible performance regression.**
_Category: Both._
An engineer reviewing their benchmark history notices that recent results show lower performance than an earlier baseline. They select two runs and request a comparison. The platform returns a statistical classification — either "Regression Detected," "Possible Regression," "Inconclusive," or "No Regression Detected" — and generates a structured comparison report. The report includes the baseline and candidate measurement distributions, the percentage change in each metric, any environmental differences between the runs, provenance limitations for imported results, and a plain-language summary from the rule-based explanation layer. The engineer uses this evidence to decide whether to investigate further. The platform does not assert a root cause.

**UC-6: Review benchmark history and export a comparison report.**
_Category: Both._
An engineer wants to share performance findings with their team. They use the dashboard to review the run history, filtered by benchmark category and date range. They select two runs, generate a comparison, and export the result as machine-readable JSON. The exported report includes the full run records, comparison result, statistical classification, percentage changes per metric, environmental difference flags, and provenance limitations where applicable. The team can process this file programmatically or archive it with their project documentation.

---

## 4. Value Proposition

Performance measurement today is fragmented. Profilers such as `perf`, `valgrind`, and `Instruments` explain where time is spent inside a running program but are not designed for reproducible historical comparison across software versions. General-purpose benchmark suites and system stress tools provide workload execution but were not built around a developer workflow with persistent structured history. Application performance monitoring services operate on instrumented production workloads and are not suited to local pre-deployment validation. Google Benchmark provides excellent benchmark execution infrastructure but does not include persistent result storage, a comparison workflow, or a web dashboard — projects using it typically build that infrastructure themselves.

SiliconScope AI is designed as an integrated developer workflow platform. The combination it provides is:

- A native C++20 synthetic benchmarking engine with defined, reproducible workloads for machine-level characterization.
- A structured import path for application-level C++ benchmark results (Google Benchmark JSON), bringing them into the same infrastructure as synthetic results.
- Hardware and OS environment capture on every run, with strict compatibility checking before any comparison.
- Git commit SHA association that makes benchmark history navigable alongside software history.
- Deterministic statistical regression analysis with evidence-based classification.
- A unified dashboard for history, detail, comparison, and reporting.
- Machine-readable comparison report export.

We make no claim that this combination is unique. We do claim that implementing it correctly — with measurement reproducibility, statistical rigor, an explicit security boundary, and honest provenance reporting — is the engineering challenge the platform is built to meet.

---

## 5. MVP Feature Set

The MVP establishes a working end-to-end system supporting both benchmark categories. Every capability listed here must be fully implemented and tested before the MVP is considered complete.

### 5.1 Native Benchmarking Agent (C++20)

**Hardware and OS discovery**

- CPU model name, physical core count, logical core count, base frequency (where readable from the OS).
- Total and available memory.
- Operating system name and version.
- All discovered hardware and environment data is captured and stored with every benchmark run, regardless of benchmark category.

**Synthetic benchmark suite**

- _CPU computation workloads:_ Integer and floating-point operations designed to stress the execution units. Workloads must include compiler optimization safeguards to prevent the optimizer from eliding the measured work.
- _Memory access workloads:_ Sequential read/write and randomized read/write patterns targeting both cache-resident and main-memory data sizes. Metrics include throughput and latency.
- _Multithreaded scaling workloads:_ Parallel execution across varying thread counts to measure scalability and synchronization overhead.

Each workload must define: workload parameters, warmup strategy, minimum repetition count, reported metrics, and units. These definitions are the authoritative implementation contract in `docs/BENCHMARK_SPEC.md`.

**Measurement quality requirements**

- Warmup runs are always executed before measurement begins.
- Repeated measurements are collected to characterize variability.
- The result record includes the distribution (min, max, mean, median, standard deviation), not only a single scalar.
- Measurement units are explicit and machine-readable in stored results.

**CLI interface**

- `sscope register --backend <url>` — register this device with a SiliconScope AI backend. Prompts interactively for the one-time setup token (hidden input). The `--token` flag does not exist; the token must never be passed as a command-line argument. On success, the assigned API key is stored in the macOS Keychain; the key is never written to disk in plaintext.
- `sscope run [suite|workload]` — execute a synthetic benchmark or full suite.
- `sscope run --commit <sha>` — associate the synthetic run with a specific Git commit SHA as contextual metadata.
- `sscope import <file.json>` — import a Google Benchmark JSON result file.
- `sscope import <file.json> --commit <sha> --build-config <descriptor>` — supply provenance metadata on import.
- `sscope status` — report agent configuration and connectivity.
- `sscope compare <run-id-a> <run-id-b>` — request a regression analysis between two stored runs.
- `sscope list` — list locally stored benchmark runs, displaying run ID, benchmark source (synthetic or user-supplied import), benchmark name or suite, timestamp, and Git SHA (if present). Supports `--source synthetic|import` for filtering by source, `--limit N` to cap the number of results, and `--format json` for machine-readable output. Works offline against locally persisted records. Run IDs in the output are accepted by `sscope compare`.

**Offline behavior**

- `sscope run` and `sscope import` must operate without backend connectivity.
- Results produced or imported while offline must be saved to local persistent storage. In-memory-only retention is not acceptable for the MVP.
- The exact local storage mechanism (structured JSON files on disk or an embedded SQLite database) is an open question to be resolved before implementation (OQ-8).
- Backend synchronization behavior — what triggers it, and how conflicts between local and remote records are handled — is an open question (OQ-9).
- Whether `sscope compare` is supported in offline mode against locally cached data is an open question (OQ-9). This must be resolved as an explicit architectural decision; it will not be assumed either way.

**Platform targets**

- macOS: primary development and validation target.
- Linux: planned second target, to be added once it can be tested end-to-end.
- Windows: deferred. No Windows support will be claimed or partially implemented in the MVP.
- The C++20 engine must use platform-specific adapters for system information to avoid coupling hardware discovery logic to a single OS API.

### 5.2 Custom C++ Benchmark Integration

This capability allows developers to import the results of their own Google Benchmark-based C++ benchmarks into SiliconScope AI for storage, historical tracking, and regression analysis.

**Import workflow**

1. The developer writes a benchmark using the standard Google Benchmark API in their own C++ project.
2. They build and run the benchmark binary using their own toolchain and build system. The platform does not participate in this step.
3. The binary produces a JSON output file via `--benchmark_format=json`.
4. The developer runs `sscope import <file.json>` with optional provenance flags.
5. The CLI validates the file, captures an environment snapshot from the local machine, stores the result, and marks it as a user-supplied import.

The platform does not build, execute, or manage the benchmark binary at any point. The import step is data parsing and validation only.

**JSON validation requirements**
The importer must reject any file that does not pass all of the following checks:

- Conforms to the expected Google Benchmark JSON schema.
- Benchmark names are non-empty, valid UTF-8 strings. Control characters (U+0000–U+001F, U+007F) are rejected. All printable characters are permitted, including `/` and other characters that appear legitimately in Google Benchmark hierarchical names (e.g., `BM_Sort/1024`). A maximum byte length is defined in `docs/BENCHMARK_SPEC.md` (OQ-11).
- Metric values are finite, non-NaN, non-negative numbers within a defined plausible range.
- Time units and throughput units are from a supported enumerated set.
- File size is within a defined maximum.
- No field in the imported data is executed, interpreted as a file path, or treated as a command.

**Statistical integrity requirements**
The importer must distinguish between raw benchmark repetitions and aggregate statistics:

- When the JSON contains raw per-repetition measurements, they are treated as the sample distribution and are eligible for full statistical analysis.
- When the JSON contains only aggregate statistics (mean, median, etc.), the result is stored and displayed but marked as aggregate-only. It must not be represented as a sample distribution, and analyses that require a sample distribution must note this limitation prominently.
- The precise parsing rules, required repetition counts for statistical eligibility, and handling of aggregate-only results are open questions to be resolved in `docs/BENCHMARK_SPEC.md` (OQ-11).

**Provenance metadata**
Every imported result record captures:

- Git commit SHA (user-supplied, nullable).
- Build configuration descriptor (user-supplied, nullable; e.g., `release`, `debug`).
- Benchmark binary name from JSON metadata, stored as a string and never executed.
- Environment snapshot from the importing machine at time of import.
- Import timestamp.
- Source marker: `user-supplied import`.

A stored Git commit SHA is not cryptographic or build-level proof that the measured binary was compiled from that revision. The platform records what the user supplied, does not attempt to verify it, and displays this limitation wherever provenance is relevant to a comparison or report.

**Comparison eligibility**
Valid JSON does not automatically qualify a result for comparison. Before two imported results can be compared, all of the following must be satisfied:

- Same benchmark identity (as defined by the scheme resolved in OQ-10).
- Same metric name and direction (lower-is-better or higher-is-better).
- Same units.
- Same workload parameters where applicable.
- Compatible build configuration (exact rules in OQ-11).
- Compatible hardware and OS environment.

If any compatibility dimension is materially different between two runs, the comparison must be flagged as potentially confounded rather than proceeding as a clean regression finding.

### 5.3 Backend (Node.js, Express, TypeScript, PostgreSQL)

**Agent communication**

- The local agent initiates outbound HTTPS connections to the backend.
- Remote-triggered operations are restricted to a predefined, validated set of synthetic benchmark operations. Arbitrary remote shell execution is not permitted under any circumstance.
- Remote triggering of custom C++ benchmark execution is explicitly out of scope for the MVP.
- The agent authenticates to the backend using a secure registration flow. The exact mechanism is an open question to be resolved in `docs/SECURITY.md` (OQ-1).

**Data model**
A benchmark run record captures: run identifier, timestamp, benchmark source (`synthetic` or `user-supplied import`), Git commit SHA (nullable), benchmark identity, workload or benchmark name, hardware snapshot, OS snapshot, measurement distribution or aggregate statistics, workload or benchmark parameters, and — for imported results — build configuration descriptor and provenance metadata.

The data model must be designed to support multiple devices per user and multiple users without requiring a multi-tenant implementation in the MVP. Single-user, single-device is the enforced scope at launch; the schema must not make expansion structurally impossible.

**API**

- REST API with explicit, versioned contracts defined in `docs/API_CONTRACTS.md`.
- Endpoints for: submitting a synthetic benchmark run result, submitting an imported benchmark result, retrieving run history (filterable by source and benchmark type), retrieving a single run in full detail, requesting a regression comparison between two runs, and retrieving a comparison report in machine-readable form.

### 5.4 Web Dashboard (React, TypeScript)

- **Run history view:** A paginated list of all benchmark runs, showing benchmark source (synthetic or imported), benchmark name or suite, date, Git SHA (if present), and key summary metrics.
- **Run detail view:** Full results for a single run, including measurement distributions or aggregate statistics (with appropriate labeling for each case), hardware snapshot, OS environment, and provenance metadata for imported results.
- **Comparison view:** Side-by-side display of two compatible benchmark runs showing the regression analysis result, percentage change per metric, the statistical classification, and any environmental differences between the two runs.
- **Comparison report:** A structured report viewable in the dashboard and exportable as machine-readable JSON. The export includes both full run records, comparison metadata, statistical classification, percentage changes, environmental difference flags, and provenance limitations where applicable. PDF export is post-MVP.

### 5.5 Regression Detection

Regression detection is performed by the backend using deterministic statistical analysis only. No LLM is involved in the MVP regression pipeline.

**Synthetic benchmarks**
Regression detection compares machine-level measurements from compatible workloads and environments. A finding of "Regression Detected" means the measured machine performance changed between two runs in a statistically meaningful way. It does not identify a software root cause.

**Custom C++ benchmarks**
Regression detection compares performance measurements of the same registered benchmark across two runs. A finding of "Regression Detected" means the measured performance of that benchmark changed meaningfully between the two recorded runs. It does not prove that the binary was built from the stated commits, or that a specific code change caused the change.

**Compatibility requirements**
A comparison is only valid if both runs satisfy all applicable compatibility criteria:

- Same benchmark identity.
- Same metric name and reported units.
- Consistent metric direction (lower-is-better or higher-is-better).
- Same or equivalent workload or benchmark parameters.
- Compatible hardware configuration.
- Compatible operating system and version.
- For imported results: compatible build configuration and compiler settings where captured.
- Compatible sampling methodology (raw repetitions vs. aggregate-only).

When any compatibility dimension differs materially, the comparison must be flagged as potentially confounded and must not be presented as a clean regression finding.

**Statistical classifications**
The analysis must produce one of four classifications:

- **Regression Detected** — the measured change exceeds the threshold for statistical significance given the observed variability. This is a statistical finding, not a confirmed diagnosis of cause.
- **Possible Regression** — a change was observed but the evidence does not fully meet the significance threshold. Measurement variability or insufficient sample size may be limiting factors.
- **Inconclusive** — the analysis cannot produce a reliable classification. Common causes: insufficient samples, high variability, aggregate-only import without raw repetitions, or missing required fields.
- **No Regression Detected** — the measured values are consistent with the baseline within the expected variability range. This does not prove that no performance regression exists; it means no statistically significant change was detected within the conditions of this comparison.

**Unresolved methodology**
The exact statistical method, minimum repetition counts, variability thresholds, confidence criteria, and handling of aggregate-only imports must be proposed and peer-reviewed in `docs/BENCHMARK_SPEC.md` before any implementation begins. These details are not decided here.

### 5.6 Rule-Based Explanation Layer

A lightweight rule-based component accompanies regression detection output with a structured plain-language summary: what was measured, what changed, what environmental factors were present, what the statistical classification means, and — for imported results — what provenance limitations apply. This is not an LLM. It operates only on data present in the run records. It must not speculate about root causes or emit recommendations it cannot support with stored measurements.

### 5.7 Git Association

**Synthetic benchmarks**
The Git commit SHA associated with a synthetic benchmark run is contextual metadata. It records the state of the developer's project at the time the run was executed. It does not imply that the synthetic workloads measured any application code from that commit, and the platform must not present it as such.

**Custom C++ benchmarks**
The Git commit SHA associated with an imported benchmark run is user-supplied metadata identifying the intended software revision. The platform stores this SHA and displays it in context, but it is not build-level proof of provenance. The platform never asserts that the benchmark binary was compiled from the stated revision. Provenance limitations are displayed wherever the SHA is presented in the context of a comparison.

**Both categories**

- The user provides a Git commit SHA explicitly via the `--commit` flag on `sscope run` or `sscope import`. It is never inferred automatically in the MVP.
- The SHA is stored as nullable metadata on every run record.
- Automatic detection of the current Git commit is not implemented in the MVP. If introduced later, it must require explicit user confirmation before the SHA is recorded.

---

## 6. Post-MVP Features

These capabilities are part of the intended long-term direction but are explicitly deferred. They will not be partially implemented in the MVP.

### Near-term (following MVP)

- **Linux platform support.** Full agent and build system support for Linux, added once a test environment is available.
- **Automatic Git commit detection.** The agent reads the current commit from `.git/HEAD` and presents it to the user for confirmation before recording.
- **Expanded CLI.** Commands for managing stored runs (deletion, tagging, re-labeling), exporting individual result records, and configuring agent behavior. `sscope list` (run history in the CLI) is part of the MVP command set (§5.1).
- **Comparison report PDF export.** Dashboard-generated human-readable PDF comparison reports.

### Medium-term

- **CI/CD pipeline integration.** A GitHub Actions workflow that runs synthetic benchmarks or imports application benchmark results on pull requests and posts regression analysis. Requires defining a policy for what constitutes a blocking regression and a separate security review for any automated execution.
- **Verified build provenance.** Cryptographic or build-system linkage between a benchmark binary and its Git revision, providing stronger evidence than user-supplied SHAs. Requires a separate security design.
- **Automated build orchestration.** Platform-managed build and execution of custom benchmarks without manual steps. Requires verified build provenance to be established first, and a separate security design. Explicitly out of scope until both prerequisites are met.
- **Multi-device support.** A single user account may register and manage multiple machines. Results are device-scoped; cross-device comparison is a separate, explicitly gated operation.
- **LLM-powered diagnostics.** An optional, opt-in analysis layer using a Claude model to generate natural-language explanations of regression findings. This layer must: operate only on data in the run records, clearly distinguish observed facts from hypotheses, cite the specific measurements it references, and never fabricate performance data or attribute root causes without evidence.

### Long-term

- **Extended workload integration.** A plugin or adapter interface supporting non-Google-Benchmark workload formats and custom measurement schemas, beyond the MVP Google Benchmark JSON import path.
- **GPU benchmarks.** Compute workloads targeting GPU execution units (CUDA, Metal, Vulkan Compute). Requires new workload categories, hardware discovery adapters, and methodology work.
- **Profiling integration.** Connecting benchmark runs to profiling data (sampling profiles, hardware performance counters) to support root cause investigation, not just regression detection.
- **Multi-user and multi-tenant support.** Organization-scoped benchmark history, shared baselines, and role-based access control.
- **Windows support.** Once the macOS and Linux implementations are stable and the platform-adapter architecture is proven.

---

## 7. Limitations and Non-Goals

The following are explicit boundaries. Violating them would misrepresent the platform's capabilities or produce unreliable results.

**Synthetic benchmark results measure the platform's own workloads, not user application code.** Results describe the behavior of the built-in synthetic workloads under the conditions of the run. They characterize machine performance and detect machine-level changes. They must not be cited as measurements of a developer's application or as general performance ratings of a machine.

**Importing benchmark results does not execute any code in the imported file.** The import step is data parsing and validation only. No executable, script, or shell command present in or referenced by the JSON file is run at any point during import or storage.

**A user-supplied Git commit SHA is not proof of build provenance.** The platform records the SHA as user-supplied metadata and does not verify that the benchmark binary was compiled from that revision. Comparison reports involving imported results display this limitation explicitly. Verified build provenance is a post-MVP feature.

**Regression detection findings are statistical classifications, not root cause diagnoses.** "Regression Detected" means a statistically meaningful change was observed between two compatible runs. It does not mean the platform has identified why the change occurred. The explanation layer reports measured facts; it does not diagnose.

**The platform does not execute arbitrary remote commands.** The agent accepts only predefined, validated synthetic benchmark job types from the backend. Custom benchmark execution through remote jobs is not permitted in the MVP. There is no general remote shell capability.

**Platform support is not claimed until validated.** macOS support will be validated before release. Linux support will be added only after end-to-end testing on a Linux environment. Windows is deferred.

**The MVP does not support multiple users or multiple registered devices.** The data model is designed to allow this in the future, but it is not implemented or tested in the MVP.

**LLM diagnostics are post-MVP.** No LLM is involved in the MVP analysis pipeline. Any future LLM integration is opt-in and subject to strict accuracy requirements.

---

## 8. Technical Risks and Proposed Mitigations

### R-1: Benchmark reproducibility on real hardware

**Risk.** Thermal throttling, OS scheduler interference, memory pressure from background processes, and power management states can cause measurement variability that obscures real signal.

**Proposed mitigations.** Warmup runs before measurement. Collect enough repetitions to characterize variability. Capture thermal and frequency state at run time where OS APIs permit. Document known interference sources. Report distributions, not only point estimates. The regression classification system must account for variability explicitly — this is a design requirement, not an afterthought.

### R-2: Compiler optimization defeating synthetic benchmark workloads

**Risk.** An optimizing C++ compiler may legally eliminate benchmark work entirely if it can prove the results are unused, producing misleadingly fast results.

**Proposed mitigations.** Use `DoNotOptimize` and `ClobberMemory` primitives (as provided by Google Benchmark or equivalent). Validate that assembly output includes the expected instructions. Document the anti-optimization strategy for each workload in `docs/BENCHMARK_SPEC.md`.

### R-3: Incompatible run comparisons producing misleading findings

**Risk.** Comparing benchmark runs from different hardware, different OS versions, different build configurations, or different workload parameters may produce regression findings that reflect environmental or configuration differences rather than genuine performance changes.

**Proposed mitigations.** The comparison pipeline must enforce compatibility checks before analysis. The compatibility criteria must be explicitly defined and versioned. When environmental or configuration differences exist between two runs, they must be surfaced prominently in the comparison report. Comparisons across materially different environments must be flagged as potentially confounded.

### R-4: Security of the local agent

**Risk.** A compromised backend or a man-in-the-middle attacker could send malicious job payloads to the agent, potentially executing unintended operations on the developer's machine.

**Proposed mitigations.** The agent must validate every inbound job against a strict allowlist of permitted synthetic benchmark operation types. The agent must not accept job payloads that include arbitrary executable paths, shell commands, or script content. TLS must be enforced for all agent-backend communication. The security model must be specified and reviewed in `docs/SECURITY.md` before any agent-backend communication code is written.

### R-5: Statistical methodology producing unreliable regression findings

**Risk.** An inadequate statistical method may produce false positives (reporting regressions that are measurement noise) or false negatives (missing real regressions). Either outcome damages trust in the platform.

**Proposed mitigations.** The statistical method, minimum sample size, variability thresholds, and classification criteria must be specified in `docs/BENCHMARK_SPEC.md` and reviewed before implementation. The method must be deterministic and reproducible given the same input data. The implementation must be unit-tested against known inputs with expected outputs.

### R-6: Platform divergence between macOS and Linux

**Risk.** System information APIs differ substantially between macOS (IOKit, `sysctl`) and Linux (`/proc`, `/sys`). Poorly abstracted hardware discovery code will create maintenance burden and subtle correctness differences between platforms.

**Proposed mitigations.** Hardware discovery must be implemented behind a platform adapter interface from the outset. The interface is defined once; each platform provides a concrete implementation. Linux support is added as a second adapter, not as conditional compilation scattered through the codebase.

### R-7: Adversarial or malformed JSON import

**Risk.** A crafted or corrupted import file could exploit parser vulnerabilities, inject unexpected data into the result store, or cause downstream analysis to produce misleading outputs.

**Proposed mitigations.** The importer must enforce a strict JSON schema before accepting any data. All numeric values must be validated as finite and within a plausible range. File size must be bounded. Benchmark name strings are treated as untrusted data: structural validation enforces UTF-8 validity, control-character rejection, and a bounded byte length; security is maintained through safe output encoding during rendering, parameterized database queries for storage, and strict separation of all imported string values from executable commands and filesystem paths. Relying on a shell-metacharacter blocklist as a security boundary is incorrect; legitimate Google Benchmark names contain characters such as `/`, and the security guarantee comes from never using imported strings as commands or paths. No field in the import is executed or interpreted as a command or file path. The importer must be tested against a corpus of malformed inputs including oversized files, non-finite values, unexpected field types, injection strings, and edge-case string content.

### R-8: User-controlled provenance data integrity

**Risk.** An imported result may carry misleading metadata — an incorrect commit SHA, a fabricated build configuration, or a misidentified benchmark name — that causes the platform to present a poorly evidenced comparison as authoritative.

**Proposed mitigations.** All imported results are permanently marked with source `user-supplied import`. The platform displays provenance limitations wherever imported results appear in comparison context. Regression analysis on imported results notes that build provenance is unverified. The platform does not prevent users from supplying incorrect metadata, but it clearly communicates the limits of what was verified. Verified build provenance is a post-MVP feature that will enable stronger claims.

---

## 9. Open Questions

These decisions are not yet made and must not be assumed. Each must be resolved in the appropriate specification document before the corresponding implementation begins.

| #     | Question                                                                                                                                                                                                                                                                                                                                                                | Resolve In               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| OQ-1  | What authentication mechanism is used for agent registration and API access? Candidates include API keys, short-lived JWTs, or mutual TLS. The choice affects security posture and the UX of initial setup.                                                                                                                                                             | `docs/SECURITY.md`       |
| OQ-2  | What is the exact statistical method for regression detection? (e.g., Welch's t-test, Mann-Whitney U, percentile comparison with a fixed confidence threshold.) What are the minimum sample sizes and variability thresholds that trigger each classification tier?                                                                                                     | `docs/BENCHMARK_SPEC.md` |
| OQ-3  | What are the minimum supported OS versions (e.g., macOS 13+, Ubuntu 22.04+), and what are the OS-version compatibility rules for regression comparisons? Specifically: are comparisons between runs from different major versions within the same OS family (e.g., macOS 14 vs. macOS 15) permitted with a confounding flag, or blocked as ineligible? The answer to the first part determines which system APIs are available and must be resolved before hardware discovery is implemented; the answer to the second part determines the behavior of FR-R-002 and must be resolved before the regression engine is implemented. | `docs/BENCHMARK_SPEC.md` |
| OQ-4  | How is the native agent distributed and installed? Options include a Homebrew formula, a shell installer script, a pre-built binary download, or build-from-source only. The choice affects the security of the installation path and the onboarding experience.                                                                                                        | `REQUIREMENTS.md`        |
| OQ-5  | What is the versioning and compatibility strategy for the benchmark result schema? If the schema changes after runs are stored, can old runs still be compared against new ones?                                                                                                                                                                                        | `docs/API_CONTRACTS.md`  |
| OQ-6  | What does the backend deployment target look like during development versus production? If development uses a local server, what changes when moving to a hosted service, and does the agent configuration need to change?                                                                                                                                              | `ARCHITECTURE.md`        |
| OQ-7  | What are the exact workload parameters for each synthetic benchmark in the initial suite? (Data sizes, thread counts, iteration strategies.) These must be defined before any workload code is written.                                                                                                                                                                 | `docs/BENCHMARK_SPEC.md` |
| OQ-8  | What is the local result persistence mechanism for offline operation? In-memory retention is not acceptable. Options include structured JSON files on disk or an embedded SQLite database. The choice affects reliability guarantees, query capability, and portability.                                                                                                | `ARCHITECTURE.md`        |
| OQ-9  | What is the backend synchronization behavior for locally persisted results? Specifically: what triggers synchronization (manual command, automatic on connectivity, or daemon-based), how are conflicts between local and remote records handled, and does `sscope compare` support offline operation against locally cached data?                                      | `ARCHITECTURE.md`        |
| OQ-10 | What is the custom benchmark identity scheme? How does the platform determine that two imported results describe the same benchmark for comparison eligibility? Options include benchmark name string matching, a user-assigned stable identifier, or a structured descriptor combining project, suite, and benchmark name.                                             | `docs/BENCHMARK_SPEC.md` |
| OQ-11 | What are the detailed parsing and statistical rules for Google Benchmark JSON imports? Specifically: which fields are required vs. optional, what constitutes a valid raw repetition vs. an aggregate result, what are the minimum repetition counts for statistical analysis eligibility, and what build configuration fields are required for comparison eligibility? | `docs/BENCHMARK_SPEC.md` |

---

_This document records approved product decisions and known open questions as of the planning phase. It is the authoritative source for project scope. Changes to scope require explicit approval and must be reflected here before implementation proceeds._
