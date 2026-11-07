import { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import axios from 'axios';
import { getRun } from '../api/runs';
import type { RunDetail, ImportEnvironment } from '../types';
import Spinner from '../components/Spinner';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getRun(id)
      .then(setRun)
      .catch((err: unknown) => {
        if (axios.isAxiosError(err) && err.response?.status === 404) {
          setError('Run not found.');
        } else if (axios.isAxiosError(err) && err.response?.status === 503) {
          setError('Backend unavailable. Please try again later.');
        } else {
          setError('Failed to load run details.');
        }
      })
      .finally(() => setLoading(false));
  }, [id]);

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
        <Link to="/" className="back-link">← Back to runs</Link>
        <div className="error-banner" role="alert">
          <p>{error}</p>
        </div>
      </main>
    );
  }

  if (!run) return null;

  const isImported = run.source === 'user-supplied import';
  const hasAggregateOnly = run.benchmark_cases.some(
    (bc) => bc.data_type === 'aggregate_only',
  );
  const importEnv = run.import_environment as ImportEnvironment | null;

  return (
    <main className="page">
      <Link to="/" className="back-link">← Back to runs</Link>

      {isImported && (
        <div className="provenance-notice" role="note">
          <strong>Notice:</strong> Commit SHA and build configuration are user-supplied
          and have not been verified by this platform.
        </div>
      )}

      {/* FR-D-010 — Aggregate-only notice */}
      {hasAggregateOnly && (
        <div className="agg-only-notice" role="note">
          <strong>Aggregate-only data:</strong> One or more benchmark cases contain only
          aggregate statistics (mean, stddev, etc.) with no raw repetition data. Full
          statistical analysis may be limited for these cases.
        </div>
      )}

      <h1 className="run-title">{run.run_name}</h1>

      <section className="detail-section" aria-label="Run metadata">
        <dl className="detail-grid">
          <dt>Session ID</dt>
          <dd>{run.session_id}</dd>

          <dt>Source</dt>
          <dd>
            <span
              className={
                run.source === 'synthetic'
                  ? 'badge badge-synthetic'
                  : 'badge badge-imported'
              }
            >
              {run.source === 'synthetic' ? 'Synthetic' : 'Imported'}
            </span>
          </dd>

          <dt>Import timestamp</dt>
          <dd>{formatDateTime(run.import_timestamp)}</dd>

          <dt>CPU</dt>
          <dd>{run.cpu_name}</dd>

          <dt>ISA</dt>
          <dd>{run.isa}</dd>

          <dt>OS</dt>
          <dd>{run.os_name} {run.os_version}</dd>

          <dt>Build type</dt>
          <dd>{run.build_type}</dd>

          <dt>Build config</dt>
          <dd>
            {run.build_config ?? (
                run.source === 'synthetic'
                  ? <span className="unverified">(not applicable)</span>
                  : <span className="unverified">(unverified)</span>
              )}
          </dd>

          <dt>Git SHA (user-supplied)</dt>
          <dd>{run.git_sha ?? '—'}</dd>

          <dt>Content fingerprint</dt>
          <dd className="mono">{run.content_fingerprint}</dd>

          <dt>Benchmark cases</dt>
          <dd>{run.benchmark_cases.length}</dd>
        </dl>
      </section>

      <section className="detail-section" aria-label="Benchmark cases">
        <h2>Benchmark Cases</h2>
        {run.benchmark_cases.length === 0 ? (
          <p className="hint">No benchmark cases.</p>
        ) : (
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th scope="col">Canonical Name</th>
                  <th scope="col">Project</th>
                  <th scope="col">Data Type</th>
                </tr>
              </thead>
              <tbody>
                {run.benchmark_cases.map((bc, i) => (
                  <tr key={i}>
                    <td>{bc.canonical_name}</td>
                    <td>{bc.project_name}</td>
                    <td>{bc.data_type}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* FR-D-012 — Import environment block (capturing machine at time of import) */}
      {isImported && importEnv && (
        <section className="detail-section" aria-label="Import environment">
          <h2>Import Environment — capturing machine at time of import</h2>
          <dl className="detail-grid">
            <dt>CPU</dt>
            <dd>{importEnv.cpu_name}</dd>
            <dt>ISA</dt>
            <dd>{importEnv.isa}</dd>
            <dt>OS</dt>
            <dd>{importEnv.os_name} {importEnv.os_version}</dd>
            <dt>Physical cores</dt>
            <dd>{importEnv.physical_cores}</dd>
            <dt>Logical cores</dt>
            <dd>{importEnv.logical_cores}</dd>
            <dt>Memory</dt>
            <dd>
              {importEnv.memory_bytes != null
                ? `${(importEnv.memory_bytes / (1024 ** 3)).toFixed(1)} GiB`
                : '—'}
            </dd>
          </dl>
        </section>
      )}
    </main>
  );
}
