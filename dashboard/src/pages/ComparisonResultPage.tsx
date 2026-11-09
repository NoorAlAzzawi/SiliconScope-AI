import { useState, useEffect, Fragment } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { getComparison } from '../api/comparisons';
import type { ComparisonResult } from '../types';
import Spinner from '../components/Spinner';

function formatDelta(delta: number | null): string {
  if (delta === null) return '—';
  const sign = delta > 0 ? '+' : '';
  return `${sign}${delta.toFixed(2)}%`;
}

function formatNs(ns: number | null): string {
  if (ns === null) return '—';
  if (ns >= 1_000_000) return `${(ns / 1_000_000).toFixed(3)} ms`;
  if (ns >= 1_000) return `${(ns / 1_000).toFixed(1)} µs`;
  return `${Math.round(ns)} ns`;
}

function deltaClass(delta: number | null): string {
  if (delta === null) return '';
  if (delta > 0) return 'delta-worse';
  if (delta < 0) return 'delta-better';
  return '';
}

function summaryLabelClass(label: string): string {
  const l = label.toLowerCase();
  if (l.includes('regression detected')) return 'summary-label summary-label-regression';
  if (l.includes('possible regression')) return 'summary-label summary-label-possible';
  if (l.includes('no regression')) return 'summary-label summary-label-ok';
  return 'summary-label summary-label-inconclusive';
}

export default function ComparisonResultPage() {
  const { id } = useParams<{ id: string }>();
  const [result, setResult] = useState<ComparisonResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getComparison(id)
      .then(setResult)
      .catch((err: unknown) => {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          setError('Comparison not found.');
        } else if (axios.isAxiosError(err) && err.response?.status === 503) {
          setError('Backend unavailable. Please try again later.');
        } else {
          setError('Failed to load comparison.');
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

  function handleExport() {
    if (!result) return;
    const json = JSON.stringify(result, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `comparison_${result.comparison_id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <main className="page-center">
        <Spinner />
      </main>
    );
  }

  if (error) {
    return (
      <main className="page">
        <Link to="/compare" className="back-link">← Back to compare</Link>
        <div className="error-banner" role="alert">
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (!result) return null;

  return (
    <main className="page">
      <Link to="/compare" className="back-link">← Back to compare</Link>

      <header className="page-header">
        <h1>Comparison Result</h1>
        <button onClick={handleExport} className="btn btn-outline" aria-label="Export comparison as JSON">
          Export JSON
        </button>
      </header>

      {/* FR-D-020 — Overall summary label prominently displayed */}
      <div
        className={summaryLabelClass(result.overall_summary.label)}
        role="status"
        aria-label={`Overall result: ${result.overall_summary.label}`}
      >
        {result.overall_summary.label}
        {' '}
        <span style={{ fontWeight: 400, fontSize: '0.875em' }}>
          ({result.overall_summary.k1} regression · {result.overall_summary.k2} possible ·{' '}
          {result.overall_summary.k3} inconclusive · {result.overall_summary.k4} no change
          {' '}/ {result.overall_summary.m} total)
        </span>
      </div>

      <section className="detail-section" aria-label="Comparison metadata">
        <dl className="detail-grid">
          <dt>Comparison ID</dt>
          <dd>{result.comparison_id}</dd>
          <dt>Session A (baseline)</dt>
          <dd>
            <Link to={`/runs/${result.session_a_id}`}>{result.session_a_id.slice(0, 8)}</Link>
          </dd>
          <dt>Session B (candidate)</dt>
          <dd>
            <Link to={`/runs/${result.session_b_id}`}>{result.session_b_id.slice(0, 8)}</Link>
          </dd>
          <dt>Computed at</dt>
          <dd>{new Date(result.computed_at).toLocaleString()}</dd>
        </dl>
      </section>

      {result.mandatory_disclaimer && (
        <div className="disclaimer" role="note">
          <strong>Warning:</strong> {result.mandatory_disclaimer}
        </div>
      )}

      {result.confounding_factors.length > 0 && (
        <section className="detail-section" aria-label="Confounding factors">
          <h2>Confounding Factors</h2>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th scope="col">Flag</th>
                  <th scope="col">Severity</th>
                  <th scope="col">Session A</th>
                  <th scope="col">Session B</th>
                </tr>
              </thead>
              <tbody>
                {result.confounding_factors.map((cf, i) => (
                  <tr key={i}>
                    <td>{cf.flag}</td>
                    <td>{cf.severity}</td>
                    <td>{cf.value_a ?? '—'}</td>
                    <td>{cf.value_b ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* FR-D-021 — Note when no statistical inference was performed (aggregate-only) */}
      {result.per_metric_results.some(
        (r) =>
          r.classification.toLowerCase().includes('aggregate_only') ||
          r.classification.toLowerCase().includes('descriptive_only') ||
          r.reason_code?.toLowerCase().includes('aggregate_only') ||
          r.reason_code?.toLowerCase().includes('descriptive_only'),
      ) && (
        <div className="agg-only-notice" role="note">
          <strong>Note:</strong> One or more metrics are marked as aggregate-only or
          descriptive-only. No statistical inference was performed for those metrics.
          Results reflect summary statistics only.
        </div>
      )}

      <section className="detail-section" aria-label="Per-metric results">
        <h2>Results</h2>
        {result.per_metric_results.length === 0 ? (
          <p className="hint">No comparable metrics found.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th scope="col">Canonical Name</th>
                  <th scope="col">Project</th>
                  <th scope="col">Metric</th>
                  <th scope="col">Classification</th>
                  <th scope="col">Change</th>
                  <th scope="col">Baseline N</th>
                  <th scope="col">Candidate N</th>
                  <th scope="col">Baseline Mean</th>
                  <th scope="col">Candidate Mean</th>
                  <th scope="col">Baseline CV</th>
                  <th scope="col">Candidate CV</th>
                </tr>
              </thead>
              <tbody>
                {result.per_metric_results.map((r, i) => (
                  <Fragment key={i}>
                    <tr>
                      <td title={r.canonical_name}>
                        <span className="cell-truncate">{r.canonical_name}</span>
                      </td>
                      <td title={r.project_name}>
                        <span className="cell-truncate">{r.project_name}</span>
                      </td>
                      <td>{r.metric}</td>
                      <td>{r.classification}</td>
                      <td className={deltaClass(r.delta_pct)}>
                        {formatDelta(r.delta_pct)}
                      </td>
                      <td>{r.n_baseline ?? '—'}</td>
                      <td>{r.n_candidate ?? '—'}</td>
                      <td>{formatNs(r.mean_baseline_ns ?? null)}</td>
                      <td>{formatNs(r.mean_candidate_ns ?? null)}</td>
                      <td>{r.cv_baseline_pct != null ? `${r.cv_baseline_pct.toFixed(1)}%` : '—'}</td>
                      <td>{r.cv_candidate_pct != null ? `${r.cv_candidate_pct.toFixed(1)}%` : '—'}</td>
                    </tr>
                    {(r.caveats ?? []).length > 0 && (
                      <tr className="caveat-row">
                        <td colSpan={11}>
                          <ul className="caveat-list">
                            {(r.caveats ?? []).map((c, j) => (
                              <li key={j}>{c}</li>
                            ))}
                          </ul>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* FR-D-022 — Rule-based explanation labeled as "automated summary" */}
      {result.rule_based_explanation && (
        <section className="detail-section" aria-label="Automated summary">
          <h2>Automated Summary</h2>
          <p className="hint" style={{ marginBottom: 8 }}>
            Generated by the rule-based analysis engine. Does not use speculative or causal language.
          </p>
          <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 'inherit', margin: 0 }}>{result.rule_based_explanation}</pre>
        </section>
      )}
    </main>
  );
}
