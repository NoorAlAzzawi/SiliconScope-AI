# SiliconScope AI — Benchmark Specification

**Version:** 1.0.0  
**Status:** Approved  
**Scope:** MVP (Phase 1)

---

## Table of Contents

1. [Purpose and Scope](#1-purpose-and-scope)
2. [Open Questions Resolved by This Document](#2-open-questions-resolved-by-this-document)
3. [Platform Requirements](#3-platform-requirements)
4. [OS Compatibility Policy](#4-os-compatibility-policy)
5. [Synthetic Workloads](#5-synthetic-workloads)
6. [Statistical Methodology](#6-statistical-methodology)
7. [Hardware Compatibility](#7-hardware-compatibility)
8. [Benchmark Identity](#8-benchmark-identity)
9. [Google Benchmark JSON Import Rules](#9-google-benchmark-json-import-rules)
10. [Metric Definitions](#10-metric-definitions)
11. [Test Cases](#11-test-cases)

---

## 1. Purpose and Scope

This document is the authoritative specification for SiliconScope AI's benchmarking behavior. It governs:

- Synthetic workload definitions and parameters
- Statistical analysis methodology for performance comparisons
- Hardware and OS compatibility rules for cross-run comparisons
- Benchmark identity and naming conventions
- Google Benchmark JSON import validation and classification rules
- Test cases that verify correct implementation of all of the above

This specification supplements PROJECT.md and REQUIREMENTS.md. Where those documents defer an answer to this specification (using phrases such as "as defined in BENCHMARK_SPEC.md"), this document is binding.

**Security constraint (verbatim, in effect for all MVP phases):**

> Importing a benchmark result MUST NOT execute any code contained in the input. File paths and executable names supplied through imported metadata MUST NEVER be interpreted as commands. The import pipeline is data parsing only.

---

## 2. Open Questions Resolved by This Document

The following open questions from PROJECT.md §9 are resolved here:

| ID    | Question                                    | Resolution                                                                   | Section |
|-------|---------------------------------------------|------------------------------------------------------------------------------|---------|
| OQ-2  | Statistical methodology for comparisons     | Welch's t-test, Holm–Bonferroni correction, four-label classification system | §6      |
| OQ-3  | Minimum macOS version + comparison policy   | Minimum macOS 13.0 (Ventura); same-family major-version difference = confounding (high severity) | §3, §4  |
| OQ-7  | Synthetic workload parameters               | Specific IDs, sizes, thread counts, timing parameters                        | §5      |
| OQ-10 | Benchmark identity and naming               | Composite key (project_name, benchmark_name); byte-exact                     | §8      |
| OQ-11 | Max benchmark name length; GB JSON rules    | 1,024 bytes UTF-8; 50 MiB file limit; full import validation rules           | §9      |

---

## 3. Platform Requirements

### 3.1 Minimum macOS Version (D-01, OQ-3 Part 1)

**Decision:** The minimum supported macOS version is **macOS 13.0 (Ventura)**.

**Reconciliation with existing requirements:**  
PROJECT.md and REQUIREMENTS.md name macOS as the primary MVP target platform without specifying a minimum version, explicitly deferring that determination to OQ-3. REQUIREMENTS.md §1.5 names macOS as primary target; FR-A-005 cites macOS 14.6.1 as an example version, not a minimum requirement. Specifying macOS 13.0 here resolves OQ-3 without changing any previously approved requirement.

**Rationale:**
- macOS 13.0 is the oldest Apple-supported macOS release at the time of writing.
- C++20 standard library support, including `std::barrier`, is fully available on macOS 13.0 via Xcode 14+ / Apple Clang 14+.
- `clock_gettime(CLOCK_MONOTONIC_RAW, &ts)` has been stable since macOS 10.12 Sierra.
- Supporting macOS 12 (Monterey) would require fallback timing paths and conditional compilation that are out of scope for MVP.

### 3.2 CI Runner Configuration (D-02)

**Decision:** CI uses the GitHub Actions `macos-14` runner (Apple Silicon M1, macOS 14.x).

**CI gap acknowledgement:**  
The `macos-14` runner validates ARM64 architecture on macOS 14 only. Intel x86_64 and macOS 13 compatibility require manual verification and are not covered by automated CI in the MVP. This gap must be documented in CI pipeline configuration.

### 3.3 Timing Implementation (D-03)

All elapsed-time measurements use `CLOCK_MONOTONIC_RAW`:

```
clock_gettime(CLOCK_MONOTONIC_RAW, &ts_start);
// ... measured work ...
clock_gettime(CLOCK_MONOTONIC_RAW, &ts_end);

elapsed_ns = (ts_end.tv_sec  - ts_start.tv_sec)  × 1,000,000,000
           + (ts_end.tv_nsec - ts_start.tv_nsec)
```

`CLOCK_MONOTONIC_RAW` is not subject to NTP adjustments. It is the correct clock for wall-time benchmarking on macOS.

---

## 4. OS Compatibility Policy

### 4.1 Rules (D-01, OQ-3 Part 2)

When comparing two benchmark runs recorded on different OS versions, apply the following rules in order:

| Condition                                                    | Outcome                                              | Severity  |
|--------------------------------------------------------------|------------------------------------------------------|-----------|
| OS family strings differ (e.g., `"macOS"` vs. `"Linux"`)    | **Blocked** — no analysis performed                  | N/A       |
| Same family, same `major.minor.patch`                        | Clean comparison                                     | N/A       |
| Same family, same major version, different minor or patch    | Confounding flag `(os_version: minor_mismatch)`      | Low       |
| Same family, different major version (e.g., macOS 14 vs. 15)| Confounding flag `(os_version: major_mismatch)`      | High      |

OS family is determined by exact string match: `"macOS"` and `"Linux"` are distinct families.

### 4.2 Rationale for Confounding (Not Blocking) on Major-Version Difference

Completely blocking same-family major-version comparisons would prevent the primary use case UC-2 (compare performance before and after an OS upgrade). Major-version OS differences are typically smaller in observed effect on workload performance than cross-family differences. The high-severity confounding flag preserves analytical utility while ensuring the limitation is surfaced to the user. Confounded comparisons are not CI gate eligible by default (§6.10).

### 4.3 Mandatory Disclaimer

All comparison reports that carry any confounding flag MUST include the following disclaimer verbatim:

> **Warning:** One or more confounding factors were detected. Results may not reflect a clean performance comparison. Review confounding details before drawing conclusions. This comparison is not eligible for use as a CI gate without explicit opt-in.

---

## 5. Synthetic Workloads

### 5.1 Common Parameters (D-03, OQ-7)

All synthetic workloads use the following shared parameters:

| Parameter        | Value                                                             |
|------------------|-------------------------------------------------------------------|
| N_warmup         | 5 iterations (results discarded)                                  |
| N_rep            | 30 iterations (results recorded)                                  |
| Minimum rep time | >= 10 ms per iteration (N_inner adjusted upward to meet this floor) |
| Clock            | `CLOCK_MONOTONIC_RAW` (see §3.3)                                  |

### 5.2 Workload Registry (OQ-7)

| Workload ID                           | Category  | Primary Metric             | Polarity |
|---------------------------------------|-----------|----------------------------|----------|
| `synthetic.cpu.integer`               | CPU       | `latency_ns`               | LIB      |
| `synthetic.cpu.float`                 | CPU       | `latency_ns`               | LIB      |
| `synthetic.memory.seq_read`           | Memory    | `throughput_bytes_per_sec` | HIB      |
| `synthetic.memory.seq_write`          | Memory    | `throughput_bytes_per_sec` | HIB      |
| `synthetic.memory.rand_read`          | Memory    | `latency_ns_per_access`    | LIB      |
| `synthetic.memory.rand_write`         | Memory    | `latency_ns_per_access`    | LIB      |
| `synthetic.thread.scaling`            | Threading | `latency_ns`               | LIB      |

**Benchmark name construction:** The benchmark_name for each synthetic measurement is the workload ID plus a variant suffix separated by `/`. CPU workloads have a single configuration, so the workload ID alone is the full benchmark_name (e.g., `"synthetic.cpu.integer"`). Memory and threading workloads produce one benchmark entry per configuration variant; the suffix encodes the distinguishing parameter (see §5.4 and §5.5). The base workload IDs in the table above are preserved unchanged.

Synthetic benchmarks use `"siliconscope_synthetic"` as the implicit project_name for identity purposes (§8.3).

### 5.3 CPU Workloads (D-04)

**Mode:** Latency-mode. Each inner iteration performs a dependent arithmetic chain, preventing compiler elimination of intermediate results.

**Integer workload (`synthetic.cpu.integer`):**
- Compute a chain of dependent integer operations (e.g., multiply-add loops) where each step depends on the previous result.
- Wrap results with `DoNotOptimize()` to prevent dead-code elimination.
- N_inner default: 10^8 iterations per repetition. Adjust upward if elapsed time < 10 ms.

**Float workload (`synthetic.cpu.float`):**
- Same structure as integer workload using double-precision floating-point operations.
- N_inner default: 10^8. Adjust upward if elapsed time < 10 ms.

**Measurement:** Record `elapsed_ns` for each of the N_rep repetitions.

### 5.4 Memory Workloads (D-05)

**Buffer sizes:** Four sizes are used, identified by numeric labels only. No cache-level claims are made; cache-level behavior depends on hardware and is not asserted. These four sizes are the final specification choices for MVP Phase 1.

| Label  | Size    | Benchmark name suffix | Example benchmark_name             |
|--------|---------|----------------------|------------------------------------|
| `4k`   | 4 KiB   | `/4k`                | `synthetic.memory.seq_read/4k`     |
| `256k` | 256 KiB | `/256k`              | `synthetic.memory.seq_read/256k`   |
| `4m`   | 4 MiB   | `/4m`                | `synthetic.memory.seq_read/4m`     |
| `64m`  | 64 MiB  | `/64m`               | `synthetic.memory.seq_read/64m`    |

Each buffer-size variant produces a distinct benchmark entry with its own composite key. The same suffix format applies to all four memory workload IDs.

**Sequential access (`seq_read`, `seq_write`):**
- Allocate buffer of target size.
- Access elements sequentially until >= 10 ms has elapsed.
- Report `throughput_bytes_per_sec = bytes_accessed / elapsed_s`.

**Random access (`rand_read`, `rand_write`):**
- Allocate buffer of target size.
- Access elements at pseudo-random indices (pre-shuffled index array to avoid index-generation cost in the timed region) until >= 10 ms has elapsed.
- Report `latency_ns_per_access = elapsed_ns / accesses_performed`.

### 5.5 Threading Workload (D-06)

**Model:** Strong scaling — fixed total work divided among T worker threads.

**Default configuration:**

| Parameter     | Value                                            |
|---------------|--------------------------------------------------|
| N_work        | 2^26 elements (uint64_t array)                   |
| Thread counts | T_set — computed at runtime (see below)          |
| Barrier       | `std::barrier` (C++20) with count = T + 1        |

**Thread count computation:**

```
logical_core_count = std::thread::hardware_concurrency()

If logical_core_count < 1 (unavailable or reports 0):
  T_set = {1}   [fallback: single-threaded only]
Else:
  T_max = min(logical_core_count, 8)
  T_set = de-duplicate(ascending-sort(
            { t in {1, 2, 4} : t <= T_max }  union  { T_max }
          ))
```

Example T_set values by logical_core_count:

| logical_core_count | T_set       |
|--------------------|-------------|
| unavailable / 0    | {1}         |
| 1                  | {1}         |
| 2                  | {1, 2}      |
| 3                  | {1, 2, 3}   |
| 4                  | {1, 2, 4}   |
| 6                  | {1, 2, 4, 6}|
| 8                  | {1, 2, 4, 8}|
| > 8                | {1, 2, 4, 8}|

T never exceeds `logical_core_count`. No duplicate T values are produced.

**Benchmark name:** For each T in T_set, the benchmark_name is `"synthetic.thread.scaling/T{T}"` where `{T}` is the integer thread count (e.g., `"synthetic.thread.scaling/T1"`, `"synthetic.thread.scaling/T4"`). Two machines with different logical_core_count produce different T_sets and therefore different sets of benchmark_names; cross-machine comparisons match only on benchmark_names present in both runs.

**Timing protocol:**

1. Main thread and T workers all wait on the barrier.
2. Barrier releases all T+1 participants; each records `t_start` immediately after returning from `barrier.arrive_and_wait()`.
3. Main thread records `t_start_main`; worker threads record their own `t_start_worker`.
4. Workers perform their partition of the array summation.
5. Workers wait on a second barrier.
6. Main thread records `t_end` after the second barrier.

**Measured interval:** The reported `elapsed_ns` spans from `t_start_main` (recorded by the main thread immediately after the first barrier releases) to `t_end` (recorded by the main thread after the second barrier). This interval **includes** the post-barrier delay before each worker thread begins computing, the computation itself, and the delay before workers arrive at the second barrier. It **excludes** thread creation time, time before the first barrier, and time after the second barrier.

**Race window:** The time between the barrier release and each thread recording its timestamp is hardware- and OS-dependent with no specified upper bound. It may be negligible on lightly loaded hardware and significant under OS scheduling pressure. This imprecision is not corrected for. Timestamps across threads are not simultaneous.

**Work partitioning (deterministic):**
- Thread `k` (0-indexed) processes elements `[k × floor(N/T), (k+1) × floor(N/T))`, except the last thread which takes all remaining elements.
- Formally: `start_k = k × floor(N/T)`, `end_k = (k < T-1) ? (k+1) × floor(N/T) : N`.

**Metric reported:** `latency_ns` per T-thread configuration.

---

## 6. Statistical Methodology

### 6.1 Overview (D-08, OQ-2)

Performance comparison uses Welch's two-sample t-test (two-tailed) at significance level alpha = 0.05, with Holm–Bonferroni multiple comparison correction applied across all metrics in a single `sscope compare` invocation.

**Constants:**

| Name                 | Value  |
|----------------------|--------|
| PRACTICAL_THRESHOLD  | 2.0 %  |
| LARGE_THRESHOLD      | 5.0 %  |
| alpha                | 0.05   |

**Metric polarity and regression_effect:** Each metric has a polarity: **LIB** (lower-is-better) or **HIB** (higher-is-better). See §5.2 and §10 for assignments. All classification decisions use the **regression_effect**, a polarity-adjusted effect size where a positive value means the candidate performed worse and a negative value means the candidate performed better:

- For LIB metrics: `regression_effect = (candidate_mean − baseline_mean) / |baseline_mean| × 100`
- For HIB metrics: `regression_effect = (baseline_mean − candidate_mean) / |baseline_mean| × 100`

The raw signed change **delta_pct** is computed and reported for display only and is not used in any classification rule:

- `delta_pct = (candidate_mean − baseline_mean) / |baseline_mean| × 100`

Guard clause G2 (`baseline_mean = 0`) applies regardless of polarity: both regression_effect formulas divide by `|baseline_mean|` and are undefined when the baseline mean is zero.

### 6.2 Guard Clauses

Apply the following checks in order before running any statistical test. The first matching clause terminates processing for that metric.

| Guard | Condition                                                     | Outcome                                              |
|-------|---------------------------------------------------------------|------------------------------------------------------|
| G1    | N_baseline < 2 OR N_candidate < 2                             | Inconclusive [insufficient_samples]                  |
| G2    | baseline_mean = 0                                             | Inconclusive [zero_baseline]                         |
| G3    | sigma_baseline = 0 AND sigma_candidate = 0 AND mean_b = mean_c | No Regression Detected [constant_samples, identical] |
| G4    | sigma_baseline = 0 AND sigma_candidate = 0 AND mean_b != mean_c | Constant-Samples Path (§6.3); no t-test             |
| G5    | sigma_baseline = 0 XOR sigma_candidate = 0                    | Standard path (§6.4), flag [one_side_zero_variance]; df = N_nonzero - 1 |
| G6    | p_adjusted is NaN, Inf, or otherwise invalid after computation | Inconclusive [undefined_statistic]                  |

### 6.3 Constant-Samples Path (G4)

When both samples have zero observed variance but unequal means, no statistical test is conducted. Zero observed variance does not establish zero population variance; the difference may reflect measurement at the timer resolution floor.

Compute `delta_pct` (display value) and `regression_effect` (classification value) as defined in §6.1.

| Condition                                    | Label                                                         |
|----------------------------------------------|---------------------------------------------------------------|
| `|regression_effect|` < PRACTICAL_THRESHOLD  | No Regression Detected [constant_samples, negligible_change]  |
| `regression_effect` <= -PRACTICAL_THRESHOLD  | No Regression Detected [constant_samples, improvement]        |
| `regression_effect` >= PRACTICAL_THRESHOLD   | Possible Regression [constant_samples]                        |

**Required output text for Possible Regression [constant_samples]:**

> Zero observed variance detected in both samples. No statistical test was conducted. The measured difference may reflect quantization at the timer resolution floor rather than a true performance change. Collect additional samples with a longer iteration duration to confirm.

No t-statistic and no p-value are reported for this path.

### 6.4 Standard Path — Welch's t-Test

For all metrics that pass G1–G6 and do not trigger G3 or G4:

```
SE  = sqrt( s_b^2 / N_b  +  s_c^2 / N_c )

t   = (candidate_mean - baseline_mean) / SE

df  = (s_b^2/N_b + s_c^2/N_c)^2
      ──────────────────────────────────────────
      (s_b^2/N_b)^2/(N_b-1) + (s_c^2/N_c)^2/(N_c-1)

p_raw = 2 × SF_t(|t|, df)        [two-tailed]
```

Where `SF_t(x, df) = 1 − CDF_t(x, df)` is the survival function (upper tail probability) of Student's t-distribution with `df` degrees of freedom. The survival function is used directly rather than `1 − CDF_t(|t|, df)` to avoid catastrophic cancellation when `|t|` is large: for `|t|` beyond approximately 8 with typical df, `1 − CDF_t` underflows to 0.0 in IEEE 754 double precision, producing an incorrect p-value of 0.0. All standard numerical libraries expose `SF_t` or an equivalent upper-tail function. The sign of `t` is not used for classification; regression direction is determined by `regression_effect` as defined in §6.1.

### 6.5 Multiple Comparison Correction (D-09)

**Family definition:** All metrics compared in a single `sscope compare` invocation. Each separate invocation is a separate family.

**Procedure (Holm–Bonferroni):**

1. Let M_p = number of metrics with a valid p_raw (metrics on the constant-samples path or guard-clause-terminated are excluded from the family).
2. Sort metrics by p_raw ascending: p_(1) <= p_(2) <= ... <= p_(M_p).
3. For rank i (1-indexed):  
   `p_adj_(i) = min( 1.0,  max( p_adj_(i-1),  (M_p - i + 1) × p_raw_(i) ) )`  
   (Set p_adj_(0) = 0 for initialization.)
4. Use p_adj_(i) in classification rules C1–C5.

### 6.6 Classification Rules (C1–C5)

Applied after guard clauses and after computing p_adjusted. Rules are mutually exclusive and exhaustive; evaluate in order and apply the first match.

Compute `regression_effect` and `delta_pct` as defined in §6.1. Use `regression_effect` for all classification conditions; report `delta_pct` for display only.

| Rule | Condition                                                                           | Label                                           |
|------|-------------------------------------------------------------------------------------|-------------------------------------------------|
| C1   | `|regression_effect|` < PRACTICAL_THRESHOLD                                         | No Regression Detected [negligible_change]      |
| C2   | `regression_effect` <= -PRACTICAL_THRESHOLD                                         | No Regression Detected [improvement]            |
| C3   | `regression_effect` >= PRACTICAL_THRESHOLD AND p_adjusted < alpha                   | Regression Detected                             |
| C4   | `regression_effect` >= LARGE_THRESHOLD AND p_adjusted >= alpha                      | Possible Regression [large_unconfirmed]         |
| C5   | PRACTICAL_THRESHOLD <= `regression_effect` < LARGE_THRESHOLD AND p_adjusted >= alpha | Inconclusive                                  |

Note: C1 and C2 are independent of p_adjusted. A negligible or improvement-direction `regression_effect` requires no statistical threshold to classify as non-regression.

### 6.7 Low Sample Count Policy (N = 2–9)

When 2 <= N_baseline < 10 OR 2 <= N_candidate < 10 (but both >= 2, so G1 does not trigger):

- The standard t-test path proceeds normally (Welch's t-test with the available N).
- Attach the flag `[low_confidence, N=K]` where K is the smaller of N_baseline and N_candidate.
- This policy applies identically to synthetic benchmarks and imported Google Benchmark results.
- **CI gate eligibility:** Not eligible by default. The operator must explicitly opt in to allow N < 10 as a CI gate.

Statistical eligibility tiers for imported data (see §9.5):

| Tier | Condition                                                | Description                     |
|------|----------------------------------------------------------|---------------------------------|
| A    | N >= 10, raw samples available                           | Full — standard path, no low-confidence flag |
| B    | 2 <= N < 10, raw samples available                       | Reduced — standard path with [low_confidence, N=K] flag |
| C    | aggregate_only, valid mean for both sides                | Degraded — descriptive-only; no t-test in MVP; carries [aggregate_only, descriptive_only] label |
| D    | N < 2, or aggregate_only without a valid mean            | Ineligible — G1 or no-analysis path |

### 6.8 CV Warning

If the coefficient of variation (CV = s / mean) exceeds 5% for either baseline or candidate sample:

- Attach the flag `[high_cv]` to the result for that metric.
- Add to output: "High variance detected (CV > 5%). Detection sensitivity is reduced."

### 6.9 Overall Summary Generation (D-09)

After classifying all M metrics in an invocation:

| Count variable | Meaning                                           |
|----------------|---------------------------------------------------|
| K1             | Count of Regression Detected                      |
| K2             | Count of Possible Regression                      |
| K3             | Count of Inconclusive                             |
| K4             | Count of No Regression Detected                   |

**Invariant:** K1 + K2 + K3 + K4 = M, where M is the count of metrics that received a C1–C5 classification label or a guard-clause termination label in this invocation. Tier C metrics (aggregate_only, descriptive_only) are reported separately and are not included in M or any K count.

**Overall summary label:**

| Condition                                         | Overall label                              |
|---------------------------------------------------|--------------------------------------------|
| M = 0 AND no Tier C comparisons                   | **Not Evaluated** — no eligible metrics    |
| M = 0 AND Tier C comparisons present              | **Descriptive only** — aggregate-only data; no C1–C5 classification performed |
| K1 > 0                                            | Regression Detected                        |
| K1 = 0 AND K2 > 0                                 | Possible Regression                        |
| K1 = 0 AND K2 = 0 AND K3 > 0 AND K4 > 0          | Inconclusive (Incomplete assessment)       |
| K1 = 0 AND K2 = 0 AND K3 > 0 AND K4 = 0          | Inconclusive                               |
| K1 = 0 AND K2 = 0 AND K3 = 0 AND M > 0           | No Regression Detected                     |

A mix of Inconclusive and No Regression Detected produces an overall "Inconclusive" label, not "Possible Regression". Elevating to "Possible Regression" requires positive evidence of regression-direction effect (K2 > 0).

**Not Evaluated** is an error condition. It arises when an invocation contains no benchmark names that match between baseline and candidate, or when all metrics are absent from one run. The operator must resolve the configuration issue; this result must never be treated as a passing gate.

### 6.10 CI Gate Eligibility and Outcomes

**Eligibility conditions:** A comparison is eligible for use as a CI gate only when **all** of the following conditions are satisfied:

1. No blocking conditions are present (§7.1): different ISA, different OS family, or Debug vs. non-Debug build. Blocking conditions are absolute — they prevent any analysis from running and cannot be overridden by operator opt-in. If confounding flags (§7.2) are present, the operator must explicitly opt in to proceed with CI gating.
2. Build configuration is verified (not `[build_config: unverified]`).
3. N >= 10 for all compared metrics — or operator has explicitly opted in.
4. No constant-samples path results are present.
5. No Tier C (aggregate_only, descriptive_only) data is present for any compared metric.
6. OS versions are compatible (same family, same major version preferred; same family + major-version mismatch requires operator opt-in).
7. At least one metric completed the standard t-test path and received a C1–C5 classification label (M_c ≥ 1), where M_c is the count of metrics with a C1–C5 label. Guard-clause terminations (G1, G2, G6) and constant-samples path results (§6.3) do not contribute to M_c. A comparison where M_c = 0 has no completed statistical comparisons and cannot produce a Pass or Fail gate result.

If any eligibility condition fails, the gate is **refused** before evaluation (see §11.5, TC-CI-1 through TC-CI-3, and TC-CI-7).

**Gate outcome table:** Once all eligibility conditions are satisfied, the CI gate result is determined by the overall summary label from §6.9:

| Overall summary label      | Default CI gate result                                           |
|----------------------------|------------------------------------------------------------------|
| No Regression Detected     | **Pass**                                                         |
| Regression Detected        | **Fail**                                                         |
| Possible Regression        | **Indeterminate** — gate blocked; must not be treated as Pass    |
| Inconclusive               | **Indeterminate** — gate blocked; must not be treated as Pass    |
| Not Evaluated              | **Error** — gate refused; must not be treated as Pass            |

**Indeterminate** results block CI. An operator must re-run with additional samples, resolve confounding factors, or explicitly record a disposition — they may not silently promote an Indeterminate result to a passing gate.

Statistical classification and CI gate status are separate outputs. A single comparison produces both an overall summary label (§6.9) and a gate result (this table). Neither implies the other beyond the mapping defined here.

The Not Evaluated row is defense-in-depth: eligibility condition 7 (M_c ≥ 1) prevents a comparison with no completed C1–C5 classifications from reaching this table under normal operation.

---

## 7. Hardware Compatibility

### 7.1 Blocking Conditions (D-12)

Comparisons between two runs MUST be blocked (no analysis performed) when:

| Condition                                | Reason                                        |
|------------------------------------------|-----------------------------------------------|
| Different ISA (e.g., x86_64 vs. ARM64)   | Fundamentally different execution environment |
| Different OS family (e.g., macOS vs. Linux) | Covered by §4.1                           |
| Debug vs. non-Debug build                | Debug disables optimizations; results are not comparable |
| `isa` or `os_name` is `"unavailable"` on either run | Hardware metadata absent; compatibility cannot be verified. Return HTTP 422 `COMPARISON_INELIGIBLE`. Do not treat as a confounding factor. **(CX-BS-1 — 2026-11-02: added per `API_CONTRACTS.md §9.2`.)** |

### 7.2 Confounding Flags

When a comparison is not blocked but differences are detected, attach a confounding flag with severity level. All confounded comparisons MUST include the mandatory disclaimer (§4.3).

| Difference                              | Flag                             | Severity |
|-----------------------------------------|----------------------------------|----------|
| Same ISA, different CPU model           | `(cpu_model: mismatch)`          | Medium   |
| Different physical core count           | `(core_count: mismatch)`         | Medium   |
| Different clock speed (> 5% difference) | `(clock_speed: mismatch)`        | Low      |
| Different memory capacity               | `(memory: capacity_mismatch)`    | Low      |
| Different memory speed                  | `(memory: speed_mismatch)`       | Low      |
| OS major version mismatch (same family) | `(os_version: major_mismatch)`   | High     |
| OS minor/patch mismatch (same family)   | `(os_version: minor_mismatch)`   | Low      |
| Build config mismatch (non-Debug)       | `(build_config: mismatch)`       | Medium   |
| Build config absent on either run       | `(build_config: unverified)`     | Medium   |

**Causal language is prohibited.** Confounding flags describe an observed difference in comparison context. They do not establish that the hardware difference caused the performance difference. Reports must not include language such as "performance changed because of hardware difference."

### 7.3 Missing Build Configuration

If build configuration metadata is absent for either run, this is an unknown compatibility condition, NOT evidence of a clean comparison. Apply `(build_config: unverified)` qualifier. Not CI gate eligible.

---

## 8. Benchmark Identity

### 8.1 Composite Key (D-11, OQ-10)

A benchmark is uniquely identified by the composite key:

```
(project_name, benchmark_name)
```

Both fields use byte-exact comparison (no normalization, no case folding, no whitespace trimming). Parameters are part of the `benchmark_name` and are not stripped or parsed for identity purposes.

### 8.2 Project Name

- Set by the `--project` flag on `sscope import`.
- `--project` is optional. If absent, defaults to `"default"`.
- **Implementation gap (GAP-1):** The `--project` flag is not yet defined in PROJECT.md §5.2 (CLI command reference) or REQUIREMENTS.md FR-I-xxx. This gap must be resolved before implementation. The default behavior (project = "default") is specified here to enable unambiguous storage without requiring a mandatory flag.

### 8.3 Synthetic Benchmarks

Synthetic workloads use `"siliconscope_synthetic"` as the implicit project_name. The benchmark_name is the workload ID plus a variant suffix for workloads with multiple configurations:
- CPU workloads (single configuration): benchmark_name = workload ID, e.g., `"synthetic.cpu.integer"`.
- Memory workloads (four buffer-size variants): benchmark_name = `"<workload_id>/<size_label>"`, e.g., `"synthetic.memory.seq_read/4k"`.
- Threading workload (T_set variants): benchmark_name = `"synthetic.thread.scaling/T{T}"`, e.g., `"synthetic.thread.scaling/T4"`.

The base workload IDs (§5.2) are unchanged. Variant suffixes are defined in §5.4 (memory) and §5.5 (threading).

### 8.4 Name Constraints

- Benchmark names MUST be valid UTF-8.
- Benchmark names MUST NOT contain control characters in the range U+0000–U+001F or U+007F.
- Maximum length: **1,024 bytes** (UTF-8 encoded). Names exceeding this limit are rejected at import time.

**Rationale for 1,024-byte limit (OQ-11):**  
Typical Google Benchmark names are under 100 bytes. Deeply parameterized names (e.g., `BM_sort<std::vector<int>>/size:65536/threads:4/alignment:64`) are typically under 200 bytes. The 1,024-byte limit provides substantial headroom for parameterized names while remaining well within any reasonable database column or display constraint. No legitimate benchmark name observed in practice approaches this limit.

---

## 9. Google Benchmark JSON Import Rules

### 9.1 Security Constraint

The import pipeline is data parsing only. It MUST NOT:
- Execute any string as a command or subprocess invocation.
- Interpret any field value as a file path and open or stat that path.
- Dynamically evaluate or compile any imported content.

### 9.2 File Constraints (OQ-11)

| Constraint        | Value         |
|-------------------|---------------|
| Maximum file size | 50 MiB        |
| Encoding          | JSON (UTF-8)  |

Files exceeding 50 MiB are rejected before any parsing begins. The 50 MiB file size limit is the final specification choice for MVP Phase 1.

### 9.3 Required Fields

**Top-level object:**
- `context` (object, required)
- `benchmarks` (array, required; may be empty)

**Per benchmark row (each element of `benchmarks`):**
- `name` (string, required)
- `real_time` (number, required)
- `time_unit` (string, required; one of: `"ns"`, `"us"`, `"ms"`, `"s"`)

Optional recognized fields: `cpu_time`, `iterations`, `bytes_per_second`, `items_per_second`, `run_type`, `run_name`, `aggregate_name`, `repetition_index`.

Unknown fields are stored as opaque metadata and do not cause rejection.

**Row-level validation outcomes:**

- **Malformed (row rejected with error):** Missing `name`, `real_time`, or `time_unit`; wrong JSON type for any required field; `real_time` value outside `(0, 10^15]`; `time_unit` value not in `{"ns", "us", "ms", "s"}`.
- **Stored with label `[run_type: unsupported]`:** A row that is structurally valid but has a `run_type` value other than `"aggregate"` or `"iteration"` (see §9.4). Stored but not used in any statistical comparison in MVP. Does not cause import rejection on its own.

**`cpu_time` behavior (D-C):** If `cpu_time` is present and within the valid range `(0, 10^15]`, it is stored as metadata. It is NOT used as the primary metric for statistical comparison in MVP. Only `real_time` drives comparisons. A missing `cpu_time` field does not cause row rejection.

### 9.4 Row Classification (D-10)

Classification applies the following steps in order; the first matching step determines the row's classification:

**Step 1 — Unknown run_type (unsupported):**  
If `run_type` is present AND its value is not in `{"aggregate", "iteration"}`, classify as **unsupported**. This applies even if `aggregate_name` is also present; an unknown `run_type` is not silently promoted to a supported aggregate classification without a documented, validated compatibility rule. No such rule exists in MVP.

**Step 2 — Explicit aggregate run_type:**  
If `run_type` equals `"aggregate"`, classify as **aggregate**.

**Step 3 — Absent run_type with aggregate_name:**  
If `run_type` is absent AND `aggregate_name` is present, classify as **aggregate**.

**Step 4 — Iteration run_type:**  
If `run_type` equals `"iteration"`, classify as **raw**. Any `aggregate_name` present on an `"iteration"` row is stored as opaque metadata and does not change the classification.

**Step 5 — Default raw:**  
If `run_type` is absent AND `aggregate_name` is absent, classify as **raw**.

**Unsupported rows** are stored with label `[run_type: unsupported]`. They are not used as raw samples or aggregate sources in any statistical or descriptive comparison in MVP. They do not cause import rejection unless they also fail other validation checks (e.g., missing required fields, out-of-range values).

### 9.5 Three-Pipeline Separation

The import pipeline has three distinct stages that MUST NOT be conflated:

1. **Parser validity:** Is the JSON well-formed and do required fields pass type/range validation? A row that fails here is rejected with an error.
2. **Stored data:** Valid rows are stored regardless of statistical eligibility. A row may be stored but not eligible for comparison.
3. **Statistical eligibility:** Can stored data be used for Welch's t-test? Determined at comparison time, not at import time.

### 9.6 Grouping and Canonical Names (D-10)

For raw rows, the canonical name is determined as follows:

- **Tier 1:** If `run_name` field is present and non-empty, `canonical_name = run_name`.
- **Tier 2 (fallback):** If `run_name` is absent or empty, `canonical_name = name`.

**Aggregate row linking:**
- An aggregate row is linked to a raw group if its `run_name` value matches the canonical_name of that group (Tier 1).
- If no `run_name` is present on the aggregate row, it is stored as an **unlinked aggregate** (Tier 2).

**No suffix stripping:** Aggregate rows are never linked by stripping suffixes from `name` (e.g., `_mean`, `_stddev`, `_cv`). Reason: suffix stripping produces ambiguous canonical names. For example, `BM_compute_stddev` would incorrectly resolve to `BM_compute` under a suffix-stripping rule.

### 9.7 Duplicate Detection (D-10)

**Scope:** Duplicate detection is scoped to a single import batch (one `sscope import` invocation), further scoped to `(project_name, canonical_name)`. Raw rows from separate import batches are never compared for duplicate `repetition_index` values, even if they share the same benchmark identity. Two rows from different import batches with matching `repetition_index` represent separate benchmark runs and must not produce a duplicate error.

A true duplicate is defined as: two raw rows within the same `(project_name, canonical_name)` group, within the same import batch, that have the same `repetition_index` value.

Multiple raw rows in the same group with **different** `repetition_index` values are valid repetitions, not duplicates. They must not be rejected.

**Missing `repetition_index`:** If a raw row has no `repetition_index` field, that row is excluded from duplicate detection. Multiple raw rows with absent `repetition_index` in the same `(project_name, canonical_name)` group within a single import batch are stored as sequential repetitions without a duplicate error.

### 9.8 Data Type Labels

Stored rows carry one of the following data type labels:

| Label                     | Meaning                                                        |
|---------------------------|----------------------------------------------------------------|
| `raw_samples_available`   | One or more raw rows are stored for this canonical name. This label applies even when N < 10. |
| `aggregate_only`          | Only aggregate rows are present; no raw rows stored.           |
| `no_measurements`         | Name is referenced but no rows of either type are present.     |
| `[run_type: unsupported]` | Row has an unrecognized `run_type` value. Stored but not used in any statistical comparison in MVP. |

### 9.9 Aggregate-Only Descriptive Path (Tier C, MVP)

When only aggregate rows are available (label = `aggregate_only`), a **descriptive-only** comparison policy applies in MVP. No inferential statistical test is conducted.

**Eligibility conditions for a descriptive comparison (all must be satisfied):**

1. Both baseline and candidate have matching benchmark identity: same composite key `(project_name, canonical_name)`.
2. Both sides have a valid `mean` aggregate row whose `real_time` value passed field validation (in range `(0, 10^15]` after at-import-time unit conversion to nanoseconds). Unit compatibility is guaranteed by this conversion; no further unit check is needed at comparison time.
3. Both sides carry label `aggregate_only`.

**When all conditions are met:**

- Compute `delta_pct = (candidate_mean − baseline_mean) / |baseline_mean| × 100` as a display value.
- Compute `regression_effect` using the metric's polarity (§6.1) as a direction indicator.
- Report label: `[aggregate_only, descriptive_only]`.
- Include a human-readable direction string (e.g., "candidate is slower by 20%" for LIB; "candidate throughput is 20% lower" for HIB).

**Prohibited outputs for Tier C:**

- No t-statistic.
- No p-value.
- No C1–C5 classification label (Regression Detected, Possible Regression, Inconclusive, No Regression Detected).
- Not CI gate eligible under any condition.

**When eligibility conditions are not met** (missing mean on either side, identity mismatch): report `[aggregate_only, not_comparable]` with a reason string. Do not attempt a comparison.

Raw observations are NEVER synthesized from aggregate statistics.

### 9.10 Numeric Field Validation

| Field                       | Valid range  |
|-----------------------------|--------------|
| `real_time`, `cpu_time`     | (0, 10^15]   |
| `iterations`                | [1, 10^10]   |
| `bytes_per_second`          | [0, 10^15]   |
| `items_per_second`          | [0, 10^15]   |

Values outside these ranges cause the row to be rejected with a descriptive error message.

### 9.11 Build Configuration (D-13)

Build configuration metadata (e.g., build type: Debug/Release/RelWithDebInfo) is extracted from the `context` object if present.

| Condition                                         | Outcome                                                    |
|---------------------------------------------------|------------------------------------------------------------|
| Either run is Debug, other is non-Debug           | **Blocked** (§7.1)                                         |
| Both runs have config, configs differ (non-Debug) | Confounding flag `(build_config: mismatch)`, severity Medium |
| Both runs have config, configs match              | Clean (for this dimension)                                 |
| Config absent for either run                      | `(build_config: unverified)` qualifier; not CI gate eligible |

Absence of build configuration is an unknown compatibility condition. It MUST NOT be treated as evidence of a clean comparison.

---

## 10. Metric Definitions

| Metric Name               | Unit                    | Polarity | Definition                                                               |
|---------------------------|-------------------------|----------|--------------------------------------------------------------------------|
| `latency_ns`              | nanoseconds             | LIB      | Wall-clock elapsed time for one repetition of the benchmark              |
| `throughput_bytes_per_sec`| bytes per second        | HIB      | Total bytes processed divided by elapsed time in seconds                 |
| `latency_ns_per_access`   | nanoseconds per access  | LIB      | Total elapsed time in nanoseconds divided by total number of memory accesses |

For imported Google Benchmark data:
- `real_time` is converted to nanoseconds using the `time_unit` field before storage. It is the sole field used for statistical comparison in MVP and is treated as a **LIB** metric (elapsed time; lower is better). The polarity formulas from §6.1 apply with this LIB assignment: a candidate with a larger `real_time` mean is a regression, regardless of what the benchmark measures.
- `bytes_per_second` and `items_per_second` are stored as metadata only and are not used for statistical comparison in MVP. They do not receive HIB polarity treatment. Throughput comparisons based on `bytes_per_second` or `items_per_second` are out of scope for MVP; only `real_time`-based comparisons are performed.

---

## 11. Test Cases

### 11.1 Statistical Methodology Test Vectors

**Note:** TV-1 through TV-11 use LIB metrics (latency_ns). For LIB metrics, `regression_effect = delta_pct`, so the computations shown in those vectors are unchanged under the polarity-aware model. TV-12 and TV-13 demonstrate HIB polarity, where `regression_effect != delta_pct`.

#### TV-1 — Constant-Samples Path, Regression Direction

```
baseline  = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100]  N=10, sigma=0
candidate = [130, 130, 130, 130, 130, 130, 130, 130, 130, 130]  N=10, sigma=0

Guards: G1 pass (N=10 >= 2). G2 pass (mean != 0). G3 fail (means differ). G4 match.
-> Constant-Samples Path
delta_pct = (130 - 100) / 100 * 100 = +30%
+30% >= PRACTICAL_THRESHOLD (2%)
Expected: Possible Regression [constant_samples]
No t-statistic. No p-value.
Required caveat text must be present in output.
```

#### TV-2 — Clear Regression with Variance

```
baseline  = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100]  N=10, mean=100, s^2=2.0
candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130]  N=10, mean=130, s^2=2.0

SE  = sqrt(2.0/10 + 2.0/10) = sqrt(0.4) = 0.63246
t   = (130 - 100) / 0.63246 = 47.434
df  = (0.2 + 0.2)^2 / ((0.2^2/9) + (0.2^2/9)) = 0.16 / 0.00889 = 18.0
p_raw ≈ 2e-20  (effectively 0 for classification purposes)
delta_pct = +30%

C3: +30% >= 2% AND p_adj < 0.05
Expected: Regression Detected
```

#### TV-3 — Constant-Samples, Negligible

```
baseline  = [100 x 10]  sigma=0
candidate = [101 x 10]  sigma=0

G4 match.
delta_pct = (101 - 100) / 100 * 100 = +1%
+1% < PRACTICAL_THRESHOLD (2%)
Expected: No Regression Detected [constant_samples, negligible_change]
```

#### TV-4 — Constant-Samples, Improvement

```
baseline  = [100 x 10]  sigma=0
candidate = [90 x 10]   sigma=0

G4 match.
delta_pct = (90 - 100) / 100 * 100 = -10%
-10% <= -PRACTICAL_THRESHOLD
Expected: No Regression Detected [constant_samples, improvement]
```

#### TV-5 — Possible Regression, Large Effect, High Variance

```
baseline  = [100, 80, 120, 60, 140, 100, 80, 120, 60, 140]  N=10, mean=100, s^2=888.89
candidate = [120, 100, 140, 80, 160, 120, 100, 140, 80, 160]  N=10, mean=120, s^2=888.89

SE  = sqrt(88.889 + 88.889) = sqrt(177.778) = 13.333
t   = (120 - 100) / 13.333 = 1.500
df  = (177.778)^2 / ((88.889^2/9) + (88.889^2/9)) = 31604.6 / 1755.8 = 18.0
p_raw ≈ 0.151
delta_pct = +20%

C4: +20% >= LARGE_THRESHOLD (5%) AND p_adj >= 0.05
Expected: Possible Regression [large_unconfirmed]
```

#### TV-6 — Inconclusive, Small Effect, High Variance

```
baseline  = [100, 80, 120, 60, 140, 100, 80, 120, 60, 140]  N=10, mean=100, s^2=888.89
candidate = [103, 83, 123, 63, 143, 103, 83, 123, 63, 143]  N=10, mean=103, s^2=888.89

SE  = 13.333
t   = 3 / 13.333 = 0.225
df  = 18.0
p_raw ≈ 0.824
delta_pct = +3%

C5: 2% <= +3% < 5% AND p_adj >= 0.05
Expected: Inconclusive
```

#### TV-7 — Insufficient Samples

```
baseline  = [100]  N=1
candidate = [115]  N=1

G1: N_baseline=1 < 2
Expected: Inconclusive [insufficient_samples]
```

#### TV-8 — Identical Constant Samples

```
baseline  = [100, 100, 100, 100, 100]  N=5, sigma=0, mean=100
candidate = [100, 100, 100, 100, 100]  N=5, sigma=0, mean=100

G3: sigma_b=0 AND sigma_c=0 AND mean_b = mean_c
Expected: No Regression Detected [constant_samples, identical]
```

#### TV-9 — Multi-Metric Holm–Bonferroni Correction (M_p=3)

```
Three metrics A, B, C with the following raw p-values and delta_pct values:
  A: p_raw=0.008,  delta_pct=+7%
  B: p_raw=0.032,  delta_pct=+8%
  C: p_raw=0.049,  delta_pct=+6%

Holm-Bonferroni (M=3):
  Sort ascending: A(0.008), B(0.032), C(0.049)
  p_adj[A] = min(1.0, max(0,     3 * 0.008)) = min(1.0, 0.024) = 0.024
  p_adj[B] = min(1.0, max(0.024, 2 * 0.032)) = min(1.0, 0.064) = 0.064
  p_adj[C] = min(1.0, max(0.064, 1 * 0.049)) = min(1.0, 0.064) = 0.064

Classification:
  A: delta=+7% >= 2%, p_adj=0.024 < 0.05  -> C3: Regression Detected
  B: delta=+8% >= 5%, p_adj=0.064 >= 0.05 -> C4: Possible Regression [large_unconfirmed]
  C: delta=+6% >= 5%, p_adj=0.064 >= 0.05 -> C4: Possible Regression [large_unconfirmed]

Key assertion: C has p_raw=0.049 < 0.05 but p_adj=0.064 >= 0.05.
A naive uncorrected test would classify C as Regression Detected. The Holm-Bonferroni
correction must prevent this.

K1=1, K2=2, K3=0, K4=0
Overall: Regression Detected (K1 > 0)
```

#### TV-10 — Low Sample Count (N=3), Exact p-Value

```
baseline  = [100, 102, 98]  N=3, mean=100, s^2=4.0
candidate = [115, 117, 113]  N=3, mean=115, s^2=4.0

SE  = sqrt(4.0/3 + 4.0/3) = sqrt(8/3)
t   = 15 / sqrt(8/3)
t^2 = 225 / (8/3) = 675/8           [exact]
df  = (8/3)^2 / ((4/3)^2/2 + (4/3)^2/2) = (64/9) / (32/9) = 4  [exact]

Exact p-value via regularized incomplete beta function:
  x = df / (df + t^2) = 4 / (4 + 675/8) = 32 / 707   [exact]
  I(x; df/2, 1/2) with a=2, b=1/2
  p_raw = 1 - (10845 * sqrt(3)) / 707^(3/2) = 0.0007801268  (independently verified)

Guards: G1 pass (N=3 >= 2). Standard path proceeds.
delta_pct = +15%
Tier B: [low_confidence, N=3]

C3: +15% >= 2% AND p_adj=0.0007801268 < 0.05
Expected: Regression Detected [low_confidence, N=3]
Not CI gate eligible by default.
```

#### TV-11 — One-Side Zero Variance (G5)

```
baseline  = [100 x 10]  N=10, sigma_b=0, mean=100
candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130]  N=10, sigma_c>0, mean=130, s^2_c=2.0

G5: sigma_b=0 XOR sigma_c=0 -> standard path, flag [one_side_zero_variance]
df = N_nonzero - 1 = 10 - 1 = 9
SE = sqrt(0/10 + 2.0/10) = sqrt(0.2) = 0.44721
t  = (130 - 100) / 0.44721 = 67.08
p_raw ≈ 2.3e-14
delta_pct = +30%

C3: +30% >= 2% AND p_adj < 0.05
Expected: Regression Detected [one_side_zero_variance]
```

#### TV-12 — Throughput Regression (HIB Metric)

```
metric: throughput_bytes_per_sec  (HIB: regression = candidate lower)

baseline  = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100]  N=10, mean=100, s^2=2.0
candidate = [68, 70, 72, 69, 71, 70, 68, 72, 70, 70]  N=10, mean=70, s^2=2.0

Polarity: HIB
regression_effect = (baseline_mean - candidate_mean) / |baseline_mean| * 100
                  = (100 - 70) / 100 * 100 = +30%
delta_pct = (70 - 100) / 100 * 100 = -30%  [display only]

SE  = sqrt(2.0/10 + 2.0/10) = 0.63246
t   = (candidate_mean - baseline_mean) / SE = (70 - 100) / 0.63246 = -47.434
|t| = 47.434, df = 18
p_raw ≈ 2e-20

C3: regression_effect=+30% >= 2% AND p_adj < 0.05
Expected: Regression Detected

Key assertion: delta_pct = -30% (candidate is numerically lower). For a LIB metric with
these same numbers, a negative delta_pct would be No Regression Detected [improvement].
For HIB, a lower candidate value is a regression.
```

#### TV-13 — Throughput Improvement (HIB Metric)

```
metric: throughput_bytes_per_sec  (HIB: improvement = candidate higher)

baseline  = [98, 100, 102, 99, 101, 100, 98, 102, 100, 100]  N=10, mean=100, s^2=2.0
candidate = [128, 130, 132, 129, 131, 130, 128, 132, 130, 130]  N=10, mean=130, s^2=2.0

Polarity: HIB
regression_effect = (baseline_mean - candidate_mean) / |baseline_mean| * 100
                  = (100 - 130) / 100 * 100 = -30%
delta_pct = (130 - 100) / 100 * 100 = +30%  [display only]

C2: regression_effect = -30% <= -PRACTICAL_THRESHOLD (-2%)
Expected: No Regression Detected [improvement]

Key assertion: delta_pct = +30% (candidate is numerically higher). For a LIB metric with
these same numbers, a positive delta_pct would be Regression Detected (C3). For HIB,
a higher candidate value is an improvement.
```

---

### 11.2 Threading Workload Test Cases

#### TC-D06-1 — Barrier Initialization

```
Precondition: T worker threads created, std::barrier count = T+1
Action: Main thread calls arrive_and_wait(); workers call arrive_and_wait()
Assertion: All T+1 participants unblock within reasonable wall time (< 1 second)
```

#### TC-D06-2 — Single-Thread Correctness

```
T=1, N_work=1,000,000, array values all 1
Action: Thread 0 sums partition [0, 1,000,000)
Assertion: result == 1,000,000
```

#### TC-D06-3 — Deterministic Work Partitioning and Result Integrity

**Subtest A — Clean partition:**

```
N_work=1,000,000, array values all 2, T=2
Partition: Thread 0 -> [0, 500,000); Thread 1 -> [500,000, 1,000,000)
Assertions:
  result[0] == 1,000,000
  result[1] == 1,000,000
  result[0] + result[1] == 2,000,000
  t_end > t_start
```

**Subtest B — Uneven partition (N not divisible by T):**

```
N_work=1,000,001, array values all 1, T=2
floor(N/T) = 500,000
Partition: Thread 0 -> [0, 500,000); Thread 1 -> [500,000, 1,000,001)
Assertions:
  result[0] == 500,000
  result[1] == 500,001
  result[0] + result[1] == 1,000,001
```

**Subtest C — Parallel vs. sequential result integrity:**

```
N_work=1,000,000, array[i] = i+1 (values 1 through 1,000,000), T=4 (or T=2 if hw_concurrency < 4)
sequential_total = N * (N+1) / 2 = 1,000,000 * 1,000,001 / 2 = 500,000,500,000  [pre-computed]
Action: Run parallel summation
Assertions:
  parallel_total == 500,000,500,000
  parallel_total == sequential_total
```

#### PE-D06-1 — Non-Gating Speedup Observation (Informational Only)

```
Array: same as TC-D06-3 Subtest A (N_work=1,000,000, values all 2)
Thread counts: T = 1, 2, 4

For each T:
  Run the timed threading workload
  Log observed_speedup(T) = elapsed_ns(T=1) / elapsed_ns(T)

No assertions. No pass/fail. Informational output only.
Purpose: Observe actual speedup under current hardware and OS scheduling conditions.
Note: observed_speedup may be less than T due to synchronization overhead, memory bandwidth
limits, or OS scheduling. This is expected and does not indicate a defect.
```

---

### 11.3 Google Benchmark JSON Import Test Cases

#### TC-D10-1 — Valid Raw Repetitions (Not Duplicates)

```
Scope: single import batch, project_name="default"
Input: Three rows with name="BM_sort", repetition_index=0, 1, 2 respectively
Expected: All three rows stored as raw samples for canonical_name="BM_sort"
Must not be rejected as duplicates.
```

#### TC-D10-2 — True Duplicate Rejection

```
Scope: single import batch, project_name="default"
Input: Two rows with name="BM_sort", both with repetition_index=0
Expected: Rejected with error "duplicate repetition_index=0 for BM_sort"
```

#### TC-D10-3 — Aggregate Row Linking via run_name (Tier 1)

```
Input:
  Raw rows: [{name:"BM_sort/512", run_name:"BM_sort/512", repetition_index:0}, ...]
  Aggregate row: {name:"BM_sort/512_mean", run_name:"BM_sort/512", aggregate_name:"mean"}
Expected:
  Aggregate row linked to group with canonical_name="BM_sort/512" (matched via run_name)
  Aggregate canonical_name is NOT derived by stripping "_mean" from name field
```

#### TC-D10-4 — Unlinked Aggregate (No run_name, Tier 2)

```
Input:
  Aggregate row: {name:"BM_compute_stddev", aggregate_name:"stddev"}
  No run_name field present.
Expected:
  Stored as unlinked aggregate.
  canonical_name = "BM_compute_stddev"  (not "BM_compute")
  No suffix stripping performed.
```

#### TC-D10-5 — Name Exceeding 1,024 Bytes

```
Input: Row with name field = string of 1,025 UTF-8 bytes
Expected: Row rejected with error "benchmark name exceeds 1,024 byte limit"
```

#### TC-D10-6a — File at Exact 50 MiB Limit

```
50 MiB = 50 × 1,048,576 = 52,428,800 bytes exactly.

Input: JSON file of exactly 52,428,800 bytes with valid minimal JSON content
Expected:
  Size check passes (at limit, not over).
  File proceeds to JSON parsing.
  Accepted if JSON is valid; rejected only if JSON is malformed.
Note: Size validation and JSON validity are independent checks. A file at the limit that
is invalid JSON fails JSON parsing, not size validation.
```

#### TC-D10-6b — File One Byte Beyond 50 MiB Limit

```
Input: JSON file of 52,428,801 bytes
Expected: Rejected before any JSON parsing.
Error must cite the exact byte limit: "file size exceeds 50 MiB limit (52,428,800 bytes maximum)"
```

#### TC-D10-7 — Separate Import Batches: No Cross-Batch Duplicate Error

```
Import batch 1 (sscope import invocation A):
  project_name="default"
  Row: {name:"BM_sort", run_name:"BM_sort", repetition_index:0, real_time:100.0, time_unit:"ns"}
Expected for batch 1: Row stored as raw sample, canonical_name="BM_sort". No error.

Import batch 2 (separate sscope import invocation B):
  project_name="default"
  Row: {name:"BM_sort", run_name:"BM_sort", repetition_index:0, real_time:115.0, time_unit:"ns"}
Expected for batch 2: Row stored as raw sample. No duplicate error.

Rationale: Duplicate detection is scoped to (project_name, canonical_name) within a single
import batch. Cross-batch rows with matching repetition_index represent separate benchmark
runs, not duplicates.
```

#### TC-D10-8 — Aggregate-Only Descriptive Path (Tier C)

```
Baseline import (aggregate_only):
  project_name="default", canonical_name="BM_parse"
  Mean aggregate row: real_time=100.0, time_unit="ns" -> stored mean=100 ns
  No raw rows present. Label: aggregate_only.

Candidate import (aggregate_only):
  project_name="default", canonical_name="BM_parse"
  Mean aggregate row: real_time=120.0, time_unit="ns" -> stored mean=120 ns
  No raw rows present. Label: aggregate_only.

Metric: latency_ns (LIB)
delta_pct = (120 - 100) / 100 * 100 = +20%  [display]
regression_effect = +20% (LIB: candidate is slower)

Expected:
  Label: [aggregate_only, descriptive_only]
  Human-readable: "candidate is slower by 20%"
  No t-statistic. No p-value.
  No C1-C5 classification label assigned.
  Not CI gate eligible.

Also verify: if only one side has a valid mean (the other is missing), output must be
  [aggregate_only, not_comparable] with reason string. No comparison attempted.
```

---

### 11.4 Build Configuration Test Cases

#### TC-D13-1 — Debug vs. Release Blocked

```
Run A context: {"library_build_type": "debug"}
Run B context: {"library_build_type": "release"}
Expected: Comparison blocked. Error: "Debug vs. non-Debug comparison is not permitted."
```

#### TC-D13-2 — Release vs. RelWithDebInfo Confounding

```
Run A context: {"library_build_type": "release"}
Run B context: {"library_build_type": "relwithdebinfo"}
Expected: Comparison proceeds with confounding flag (build_config: mismatch), severity Medium.
Mandatory disclaimer present in output.
Not CI gate eligible.
```

#### TC-D13-3 — Matching Build Configurations (Clean)

```
Run A context: {"library_build_type": "release"}
Run B context: {"library_build_type": "release"}
Expected: Clean comparison (no build config confounding flag).
```

#### TC-D13-4 — Missing Build Configuration

```
Run A context: {"library_build_type": "release"}
Run B context: {}  (no library_build_type field)
Expected: Comparison proceeds with (build_config: unverified) qualifier.
Mandatory disclaimer present in output.
Not CI gate eligible.
Must not be classified as a clean comparison.
```

---

### 11.5 CI Gate Eligibility Test Cases

#### TC-CI-1 — Gate Refused: Low Sample Count

```
Input: Comparison result containing at least one metric with flag [low_confidence, N=3]
Action: Operator requests CI gate evaluation (no explicit opt-in provided)
Expected: Gate evaluation refused.
Output must include: "Not CI gate eligible: low sample count (N=3 < 10 required). Operator opt-in required to override."
```

#### TC-CI-2 — Gate Refused: Confounding Flag

```
Input: Comparison result carrying confounding flag (os_version: major_mismatch)
Action: Operator requests CI gate evaluation without explicit opt-in
Expected: Gate evaluation refused.
Output must include: "Not CI gate eligible: confounding factors detected. Operator opt-in required."
```

#### TC-CI-3 — Gate Refused: Aggregate-Only Data

```
Input: Comparison result where any metric carries label [aggregate_only, descriptive_only]
Action: Operator requests CI gate evaluation
Expected: Gate evaluation refused unconditionally (no opt-in path exists for Tier C).
Output must include: "Not CI gate eligible: aggregate-only descriptive comparison cannot be used as a CI gate."
```

#### TC-CI-4 — Gate Pass: Eligible Comparison, No Regression Detected

```
Preconditions:
  All 7 eligibility conditions satisfied:
    clean hardware, verified build config (release), N=30 for all metrics,
    no constant-samples path, no Tier C, same OS major version, M_c≥1
  Overall summary label = No Regression Detected (K1=0, K2=0, K3=0, K4>0, M>0)
Action: Operator requests CI gate evaluation
Expected: Gate result = Pass
Output must include: "CI gate: Pass"
```

#### TC-CI-5 — Gate Fail: Eligible Comparison, Regression Detected

```
Preconditions:
  All 7 eligibility conditions satisfied (same as TC-CI-4)
  Overall summary label = Regression Detected (K1 > 0)
Action: Operator requests CI gate evaluation
Expected: Gate result = Fail
Output must include: "CI gate: Fail"
```

#### TC-CI-6 — Gate Indeterminate: Eligible Comparison, Inconclusive Result

```
Preconditions:
  All 7 eligibility conditions satisfied (same as TC-CI-4)
  Overall summary label = Inconclusive (K3 > 0, K1=0, K2=0)
  Example: metric has 2% <= regression_effect < 5% with p_adjusted >= 0.05 (C5)
Action: Operator requests CI gate evaluation
Expected: Gate result = Indeterminate (gate blocked)
Must not be treated as Pass.
Output must include: "CI gate: Indeterminate — gate blocked. Result is Inconclusive."
```

#### TC-CI-7 — Gate Refused: Zero Eligible Metrics (Condition 7 Failure)

```
Preconditions:
  Eligibility conditions 1–6 would otherwise be satisfied (clean hardware,
    verified build config, N≥10 on any metrics that exist, no constant-samples path,
    no Tier C, compatible OS)
  No benchmark names match between baseline and candidate runs → M_c = 0, no Tier C comparisons
  Eligibility condition 7 fails: M_c = 0 (no metrics completed the standard t-test path)
Action: Operator requests CI gate evaluation
Expected: Gate evaluation refused before evaluation.
Must not be treated as Pass.
Output must include: "Not CI gate eligible: no completed statistical comparisons (M_c=0)."
```

#### TC-CI-8 — Gate Indeterminate: Eligible Comparison, Possible Regression

```
Preconditions:
  All 7 eligibility conditions satisfied:
    clean hardware, verified build config (release), N=30 for all metrics,
    no constant-samples path, no Tier C, same OS major version, M_c≥1
  Overall summary label = Possible Regression (K2 > 0, K1 = 0)
  Example: metric has regression_effect >= LARGE_THRESHOLD (5%) with p_adjusted >= 0.05
    (C4: Possible Regression [large_unconfirmed])
Action: Operator requests CI gate evaluation
Expected: Gate result = Indeterminate (gate blocked)
Must not be treated as Pass.
Output must include: "CI gate: Indeterminate — gate blocked. Result is Possible Regression."
```

---

## Appendix A — Known Implementation Gaps

The following gaps must be addressed before implementation begins:

| Gap ID | Description                                                                                    | Action Required                                   |
|--------|------------------------------------------------------------------------------------------------|---------------------------------------------------|
| GAP-1  | `--project` flag for `sscope import` is not defined in PROJECT.md §5.2 or REQUIREMENTS.md     | Add to PROJECT.md CLI spec and REQUIREMENTS.md FR-I-xxx before implementation |
| GAP-2  | REQUIREMENTS.md FR-C-009 retains "[PROPOSED SCOPE ADDITION — PENDING PROJECT.MD UPDATE]" marker, but PROJECT.md §5.1 already includes `sscope list` | Remove stale marker from REQUIREMENTS.md; mark FR-C-009 as approved scope |
| GAP-3  | REQUIREMENTS.md §17 still lists `sscope list` as "Proposed addition — blocked on PROJECT.MD update" | Update §17 status to reflect PROJECT.MD §5.1 inclusion |
| GAP-4  | CI validates ARM64/macOS 14 only; Intel x86_64 and macOS 13 compatibility require manual verification | Document in CI pipeline; schedule manual verification before public release |

---

*End of BENCHMARK_SPEC.md*
