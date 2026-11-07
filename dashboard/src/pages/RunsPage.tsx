import { useState, useEffect, useCallback } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import axios from 'axios';
import { getRuns } from '../api/runs';
import type { RunListItem, Pagination } from '../types';
import Spinner from '../components/Spinner';

type SourceFilter = 'all' | 'synthetic' | 'user-supplied import';

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function formatNs(ns: number): string {
  if (ns < 1_000) return `${ns.toFixed(1)} ns`;
  if (ns < 1_000_000) return `${(ns / 1_000).toFixed(2)} µs`;
  return `${(ns / 1_000_000).toFixed(2)} ms`;
}

export default function RunsPage() {
  const navigate = useNavigate();
  const [runs, setRuns] = useState<RunListItem[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  // FR-D-013 — run selection for comparison (at most 2)
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(searchQuery), 400);
    return () => clearTimeout(id);
  }, [searchQuery]);

  const fetchRuns = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params: Record<string, string | number> = { page, page_size: 25 };
      if (sourceFilter !== 'all') params['source'] = sourceFilter;
      if (dateFrom) params['date_from'] = dateFrom;
      if (dateTo) params['date_to'] = dateTo;
      if (debouncedQ) params['q'] = debouncedQ;
      const data = await getRuns(params);
      setRuns(data.data);
      setPagination(data.pagination);
    } catch (err: unknown) {
      if (axios.isAxiosError(err) && err.response?.status === 503) {
        setError('Backend unavailable. Please try again later.');
      } else if (axios.isAxiosError(err)) {
        setError(`Failed to load runs (${err.response?.status ?? 'network error'}).`);
      } else {
        setError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  }, [page, sourceFilter, dateFrom, dateTo, debouncedQ]);

  useEffect(() => {
    fetchRuns();
  }, [fetchRuns]);

  function handleSourceChange(e: React.ChangeEvent<HTMLSelectElement>) {
    setSourceFilter(e.target.value as SourceFilter);
    setPage(1);
    setSelectedRuns(new Set());
    setSearchQuery('');
    setDebouncedQ('');
  }

  function handleDateFromChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateFrom(e.target.value);
    setPage(1);
    setSelectedRuns(new Set());
    setSearchQuery('');
    setDebouncedQ('');
  }

  function handleDateToChange(e: React.ChangeEvent<HTMLInputElement>) {
    setDateTo(e.target.value);
    setPage(1);
    setSelectedRuns(new Set());
    setSearchQuery('');
    setDebouncedQ('');
  }

  function handleSearchChange(e: React.ChangeEvent<HTMLInputElement>) {
    setSearchQuery(e.target.value);
    setPage(1);
    setSelectedRuns(new Set());
  }

  // FR-D-013 — toggle run selection (max 2)
  function toggleRunSelection(id: string) {
    setSelectedRuns((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < 2) {
        next.add(id);
      }
      return next;
    });
  }

  function handleCompareSelected() {
    const ids = Array.from(selectedRuns);
    if (ids.length === 2) {
      navigate(`/compare?a=${encodeURIComponent(ids[0])}&b=${encodeURIComponent(ids[1])}`);
    }
  }

  return (
    <main className="page">
      <header className="page-header">
        <h1>Run History</h1>
        <Link to="/compare" className="btn">Compare runs</Link>
      </header>

      <section className="filters" aria-label="Filter runs">
        <div className="filter-group">
          <label htmlFor="source-filter">Source</label>
          <select
            id="source-filter"
            value={sourceFilter}
            onChange={handleSourceChange}
            aria-label="Filter by source"
          >
            <option value="all">All</option>
            <option value="synthetic">Synthetic</option>
            <option value="user-supplied import">Imported</option>
          </select>
        </div>
        <div className="filter-group">
          <label htmlFor="search-query">Search</label>
          <input
            id="search-query"
            type="search"
            value={searchQuery}
            onChange={handleSearchChange}
            placeholder="Run name or benchmark…"
            maxLength={200}
            aria-label="Search by run name or benchmark name"
          />
        </div>
        <div className="filter-group">
          <label htmlFor="date-from">From</label>
          <input
            id="date-from"
            type="date"
            value={dateFrom}
            onChange={handleDateFromChange}
            aria-label="Start date"
          />
        </div>
        <div className="filter-group">
          <label htmlFor="date-to">To</label>
          <input
            id="date-to"
            type="date"
            value={dateTo}
            onChange={handleDateToChange}
            aria-label="End date"
          />
        </div>
      </section>

      {loading && (
        <div className="page-center">
          <Spinner />
        </div>
      )}

      {!loading && error && (
        <div className="error-banner" role="alert">
          <p>{error}</p>
          <button onClick={fetchRuns} className="btn btn-outline">Retry</button>
        </div>
      )}

      {!loading && !error && runs.length === 0 && (
        <div className="empty-state">
          <p>No benchmark runs found.</p>
          <p className="hint">
            Run <code>sscope run</code> to record your first benchmark.
          </p>
        </div>
      )}

      {!loading && !error && runs.length > 0 && (
        <>
          {/* FR-D-013 — comparison action bar when 2 runs selected */}
          {selectedRuns.size > 0 && (
            <div className="compare-action">
              <p>
                {selectedRuns.size === 1
                  ? 'Select one more run to compare.'
                  : '2 runs selected.'}
              </p>
              <button
                className="btn"
                onClick={handleCompareSelected}
                disabled={selectedRuns.size !== 2}
                aria-label="Compare selected runs"
              >
                Compare selected
              </button>
              <button
                className="btn btn-outline"
                onClick={() => setSelectedRuns(new Set())}
                aria-label="Clear selection"
              >
                Clear
              </button>
            </div>
          )}

          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th scope="col" aria-label="Select for comparison"></th>
                  <th scope="col">Run ID</th>
                  <th scope="col">Source</th>
                  <th scope="col">Run Name</th>
                  <th scope="col">CPU</th>
                  <th scope="col">ISA</th>
                  <th scope="col">OS Version</th>
                  <th scope="col">Build Type</th>
                  <th scope="col">Date / Time</th>
                  <th scope="col">Git SHA</th>
                  <th scope="col">Primary Metric</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const isChecked = selectedRuns.has(run.session_id);
                  const isDisabled = !isChecked && selectedRuns.size >= 2;
                  return (
                    <tr key={run.session_id}>
                      <td style={{ width: 36, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          disabled={isDisabled}
                          onChange={() => toggleRunSelection(run.session_id)}
                          aria-label={`Select run ${run.session_id.slice(0, 8)} for comparison`}
                        />
                      </td>
                      <td>
                        <Link to={`/runs/${run.session_id}`} className="run-id-link">
                          {run.session_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td>
                        <span
                          className={
                            run.source === 'synthetic'
                              ? 'badge badge-synthetic'
                              : 'badge badge-imported'
                          }
                        >
                          {run.source === 'synthetic' ? 'Synthetic' : 'Imported'}
                        </span>
                      </td>
                      <td>{run.run_name}</td>
                      <td>{run.cpu_name}</td>
                      <td>{run.isa}</td>
                      <td>{run.os_version}</td>
                      <td>{run.build_type}</td>
                      <td>{formatDateTime(run.import_timestamp)}</td>
                      <td>{run.git_sha ? run.git_sha.slice(0, 8) : '—'}</td>
                      <td>
                        {run.primary_metric ? (
                          <span
                            title={`${run.primary_metric.project_name}/${run.primary_metric.canonical_name} (n=${run.primary_metric.sample_count})`}
                          >
                            {formatNs(run.primary_metric.mean_real_time_ns)}
                            <small style={{ display: 'block', color: 'var(--text-muted)', fontSize: '0.75em' }}>
                              {run.primary_metric.canonical_name}
                            </small>
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {pagination && (
            <nav className="pagination" aria-label="Pagination">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                aria-label="Previous page"
                className="btn btn-outline"
              >
                Previous
              </button>
              <span className="pagination-info">
                Page {pagination.page} of {pagination.total_pages}
                {' '}({pagination.total_count} total)
              </span>
              <button
                onClick={() => setPage((p) => p + 1)}
                disabled={page >= pagination.total_pages}
                aria-label="Next page"
                className="btn btn-outline"
              >
                Next
              </button>
            </nav>
          )}
        </>
      )}
    </main>
  );
}
