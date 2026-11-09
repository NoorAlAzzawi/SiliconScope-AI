export interface Pagination {
  page: number;
  page_size: number;
  total_count: number;
  total_pages: number;
}

export interface RunListItem {
  session_id: string;
  run_name: string;
  source: string;
  import_timestamp: string;
  submitted_at: string;
  os_name: string;
  os_version: string;
  cpu_name: string;
  isa: string;
  build_type: string;
  git_sha: string | null;
  benchmark_count: number;
  primary_metric: PrimaryMetric | null;
}

export interface RunListResponse {
  data: RunListItem[];
  pagination: Pagination;
}

export interface BenchmarkCase {
  project_name: string;
  canonical_name: string;
  data_type: string;
  measurements: unknown;
}

/** Hardware/OS snapshot of the machine that ran sscope import (FR-I-012). */
export interface ImportEnvironment {
  cpu_name: string;
  isa: string;
  logical_cores: number;
  memory_bytes: number;
  os_name: string;
  os_version: string;
  physical_cores: number;
}

export interface PrimaryMetric {
  canonical_name: string;
  project_name: string;
  mean_real_time_ns: number;
  sample_count: number;
}

export interface RunDetail {
  session_id: string;
  run_name: string;
  os_name: string;
  os_version: string;
  cpu_name: string;
  isa: string;
  build_type: string;
  source: string;
  source_marker: string | null;
  git_sha: string | null;
  build_config: string | null;
  import_timestamp: string;
  import_environment: ImportEnvironment | null;
  submitted_at: string;
  content_fingerprint: string;
  benchmark_cases: BenchmarkCase[];
}

export interface ConfoundingFactor {
  flag: string;
  severity: string;
  value_a?: string;
  value_b?: string;
}

export interface PerMetricResult {
  project_name: string;
  canonical_name: string;
  metric: string;
  polarity: string;
  classification: string;
  flags: string[];
  delta_pct: number | null;
  regression_effect: number | null;
  t_statistic: number | null;
  p_raw: number | null;
  p_adjusted: number | null; // Holm–Bonferroni adjusted p-value
  reason_code: string | null;
  n_baseline: number | null;
  n_candidate: number | null;
  mean_baseline_ns: number | null;
  mean_candidate_ns: number | null;
  cv_baseline_pct: number | null;
  cv_candidate_pct: number | null;
  caveats?: string[];
}

export interface OverallSummary {
  label: string;
  k1: number;
  k2: number;
  k3: number;
  k4: number;
  m: number;
}

export interface ComparisonResult {
  comparison_id: string;
  session_a_id: string;
  session_b_id: string;
  computed_at: string;
  confounding_factors: ConfoundingFactor[];
  mandatory_disclaimer: string | null;
  per_metric_results: PerMetricResult[];
  overall_summary: OverallSummary;
  rule_based_explanation: string;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    details?: Array<{ field: string; issue: string }>;
  };
}
