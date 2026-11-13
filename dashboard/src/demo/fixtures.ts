import type { RunListResponse, RunDetail, ComparisonResult } from '../types';

export const DEMO_SESSION_A_ID = 'demo-session-baseline';
export const DEMO_SESSION_B_ID = 'demo-session-candidate';
export const DEMO_COMPARISON_ID = 'demo-comparison-01';

const DEMO_BENCHMARK_CASES = [
  {
    project_name: 'SiliconScope',
    canonical_name: 'BM_cpu_integer',
    data_type: 'real_time_ns',
    measurements: null as unknown,
  },
  {
    project_name: 'SiliconScope',
    canonical_name: 'BM_memory_bandwidth',
    data_type: 'real_time_ns',
    measurements: null as unknown,
  },
  {
    project_name: 'SiliconScope',
    canonical_name: 'BM_cache_access',
    data_type: 'real_time_ns',
    measurements: null as unknown,
  },
];

export const DEMO_RUN_LIST: RunListResponse = {
  data: [
    {
      session_id: DEMO_SESSION_A_ID,
      run_name: 'Demo Run — macOS ARM64 (Baseline)',
      source: 'synthetic',
      import_timestamp: '2026-11-01T10:00:00.000Z',
      submitted_at: '2026-11-01T10:00:00.000Z',
      os_name: 'macOS',
      os_version: '14.3.1',
      cpu_name: 'Apple M2',
      isa: 'arm64',
      build_type: 'Release',
      git_sha: 'abc123def456ab',
      benchmark_count: 3,
      primary_metric: {
        canonical_name: 'BM_cpu_integer',
        project_name: 'SiliconScope',
        mean_real_time_ns: 125_000_000,
        sample_count: 30,
      },
    },
    {
      session_id: DEMO_SESSION_B_ID,
      run_name: 'Demo Run — macOS ARM64 (Candidate)',
      source: 'synthetic',
      import_timestamp: '2026-11-02T10:00:00.000Z',
      submitted_at: '2026-11-02T10:00:00.000Z',
      os_name: 'macOS',
      os_version: '14.3.1',
      cpu_name: 'Apple M2',
      isa: 'arm64',
      build_type: 'Release',
      git_sha: 'deadbeef1234de',
      benchmark_count: 3,
      primary_metric: {
        canonical_name: 'BM_cpu_integer',
        project_name: 'SiliconScope',
        mean_real_time_ns: 143_625_000,
        sample_count: 30,
      },
    },
  ],
  pagination: {
    page: 1,
    page_size: 25,
    total_count: 2,
    total_pages: 1,
  },
};

export const DEMO_RUN_BASELINE: RunDetail = {
  session_id: DEMO_SESSION_A_ID,
  run_name: 'Demo Run — macOS ARM64 (Baseline)',
  os_name: 'macOS',
  os_version: '14.3.1',
  cpu_name: 'Apple M2',
  isa: 'arm64',
  build_type: 'Release',
  source: 'synthetic',
  source_marker: null,
  git_sha: 'abc123def456ab',
  build_config: null,
  import_timestamp: '2026-11-01T10:00:00.000Z',
  import_environment: null,
  submitted_at: '2026-11-01T10:00:00.000Z',
  content_fingerprint: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
  benchmark_cases: DEMO_BENCHMARK_CASES,
};

export const DEMO_RUN_CANDIDATE: RunDetail = {
  session_id: DEMO_SESSION_B_ID,
  run_name: 'Demo Run — macOS ARM64 (Candidate)',
  os_name: 'macOS',
  os_version: '14.3.1',
  cpu_name: 'Apple M2',
  isa: 'arm64',
  build_type: 'Release',
  source: 'synthetic',
  source_marker: null,
  git_sha: 'deadbeef1234de',
  build_config: null,
  import_timestamp: '2026-11-02T10:00:00.000Z',
  import_environment: null,
  submitted_at: '2026-11-02T10:00:00.000Z',
  content_fingerprint: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
  benchmark_cases: DEMO_BENCHMARK_CASES,
};

// Comparison: baseline (A) vs candidate (B).
// BM_cpu_integer:    +14.9% → regression C1  (mean: 125ms vs 143.625ms)
// BM_memory_bandwidth: -7.8% → no change C4  (mean: 250ms vs 230.5ms)
// BM_cache_access:    +1.2% → inconclusive C3, CV 8.4%/9.1% → high_cv flag
export const DEMO_COMPARISON: ComparisonResult = {
  comparison_id: DEMO_COMPARISON_ID,
  session_a_id: DEMO_SESSION_A_ID,
  session_b_id: DEMO_SESSION_B_ID,
  computed_at: '2026-11-02T11:00:00.000Z',
  confounding_factors: [],
  mandatory_disclaimer: null,
  per_metric_results: [
    {
      project_name: 'SiliconScope',
      canonical_name: 'BM_cpu_integer',
      metric: 'real_time_ns',
      polarity: 'LIB',
      classification: 'C1',
      flags: [],
      delta_pct: 14.9,
      regression_effect: 14.9,
      t_statistic: 8.4,
      p_raw: 0.0001,
      p_adjusted: 0.0003,
      reason_code: null,
      n_baseline: 30,
      n_candidate: 30,
      mean_baseline_ns: 125_000_000,
      mean_candidate_ns: 143_625_000,
      cv_baseline_pct: 1.5,
      cv_candidate_pct: 1.8,
      caveats: [],
    },
    {
      project_name: 'SiliconScope',
      canonical_name: 'BM_memory_bandwidth',
      metric: 'real_time_ns',
      polarity: 'LIB',
      classification: 'C4',
      flags: [],
      delta_pct: -7.8,
      regression_effect: -7.8,
      t_statistic: -5.2,
      p_raw: 0.0001,
      p_adjusted: 0.0003,
      reason_code: null,
      n_baseline: 30,
      n_candidate: 30,
      mean_baseline_ns: 250_000_000,
      mean_candidate_ns: 230_500_000,
      cv_baseline_pct: 2.1,
      cv_candidate_pct: 1.9,
      caveats: [],
    },
    {
      project_name: 'SiliconScope',
      canonical_name: 'BM_cache_access',
      metric: 'real_time_ns',
      polarity: 'LIB',
      classification: 'C3',
      flags: ['high_cv'],
      delta_pct: 1.2,
      regression_effect: 1.2,
      t_statistic: 0.3,
      p_raw: 0.78,
      p_adjusted: 0.78,
      reason_code: 'INCONCLUSIVE_HIGH_CV',
      n_baseline: 10,
      n_candidate: 10,
      mean_baseline_ns: 45_000_000,
      mean_candidate_ns: 45_540_000,
      cv_baseline_pct: 8.4,
      cv_candidate_pct: 9.1,
      caveats: [
        'High variance detected (baseline CV=8.4%, candidate CV=9.1%). Detection sensitivity is reduced.',
      ],
    },
  ],
  overall_summary: {
    label: 'Regression detected',
    k1: 1,
    k2: 0,
    k3: 1,
    k4: 1,
    m: 3,
  },
  rule_based_explanation:
    'BM_cpu_integer: regression detected (+14.9%; baseline 125.000 ms vs. candidate 143.625 ms, ' +
    "Welch's t=8.40, Holm–Bonferroni-adjusted p=0.0003). " +
    'BM_memory_bandwidth: no significant change detected (−7.8%; baseline 250.000 ms vs. candidate 230.500 ms, ' +
    'Holm–Bonferroni-adjusted p=0.0003). ' +
    'BM_cache_access: inconclusive — high variance (CV 8.4% / 9.1%) reduces detection sensitivity.',
};
