import type { RunListResponse, RunDetail, ComparisonResult } from '../src/types/index';

export const SESSION_A = 'aaaaaaaa-1111-4000-8000-aaaaaaaaaaaa';
export const SESSION_B = 'bbbbbbbb-2222-4000-8000-bbbbbbbbbbbb';
export const COMPARISON_ID = 'cccccccc-3333-4000-8000-cccccccccccc';

export const runListFixture: RunListResponse = {
  data: [
    {
      session_id: SESSION_A,
      run_name: 'Baseline Run',
      source: 'synthetic',
      import_timestamp: '2026-11-08T10:00:00.000Z',
      submitted_at: '2026-11-08T10:00:00.000Z',
      os_name: 'macOS',
      os_version: '14.0',
      cpu_name: 'Apple M3',
      isa: 'arm64',
      build_type: 'release',
      git_sha: null,
      benchmark_count: 2,
      primary_metric: {
        canonical_name: 'BM_cpu_integer',
        project_name: 'SiliconScope',
        mean_real_time_ns: 125_000_000,
        sample_count: 30,
      },
    },
    {
      session_id: SESSION_B,
      run_name: 'Candidate Run',
      source: 'synthetic',
      import_timestamp: '2026-11-08T11:00:00.000Z',
      submitted_at: '2026-11-08T11:00:00.000Z',
      os_name: 'macOS',
      os_version: '14.0',
      cpu_name: 'Apple M3',
      isa: 'arm64',
      build_type: 'release',
      git_sha: null,
      benchmark_count: 2,
      primary_metric: {
        canonical_name: 'BM_cpu_integer',
        project_name: 'SiliconScope',
        mean_real_time_ns: 185_000_000,
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

export const runDetailFixture: RunDetail = {
  session_id: SESSION_A,
  run_name: 'Baseline Run',
  os_name: 'macOS',
  os_version: '14.0',
  cpu_name: 'Apple M3',
  isa: 'arm64',
  build_type: 'release',
  source: 'synthetic',
  source_marker: null,
  git_sha: null,
  build_config: null,
  import_timestamp: '2026-11-08T10:00:00.000Z',
  import_environment: null,
  submitted_at: '2026-11-08T10:00:00.000Z',
  content_fingerprint: 'aa'.repeat(32),
  benchmark_cases: [
    {
      project_name: 'SiliconScope',
      canonical_name: 'BM_cpu_integer',
      data_type: 'raw_samples_available',
      measurements: null,
    },
    {
      project_name: 'SiliconScope',
      canonical_name: 'BM_cpu_float',
      data_type: 'raw_samples_available',
      measurements: null,
    },
  ],
};

export const comparisonFixture: ComparisonResult = {
  comparison_id: COMPARISON_ID,
  session_a_id: SESSION_A,
  session_b_id: SESSION_B,
  computed_at: '2026-11-08T12:00:00.000Z',
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
      delta_pct: 48.0,
      regression_effect: 48.0,
      t_statistic: 12.4,
      p_raw: 0.0001,
      p_adjusted: 0.0001,
      reason_code: null,
      n_baseline: 30,
      n_candidate: 30,
      mean_baseline_ns: 125_000_000,
      mean_candidate_ns: 185_000_000,
      cv_baseline_pct: 1.5,
      cv_candidate_pct: 1.8,
      caveats: [],
    },
  ],
  overall_summary: {
    label: 'Regression detected',
    k1: 1,
    k2: 0,
    k3: 0,
    k4: 0,
    m: 1,
  },
  rule_based_explanation: 'Major regression detected in BM_cpu_integer.',
};
