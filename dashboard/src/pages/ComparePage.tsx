import { useState, useEffect, type FormEvent } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import axios from 'axios';
import { createComparison } from '../api/comparisons';
import type { ApiError } from '../types';

function isApiError(data: unknown): data is ApiError {
  return (
    typeof data === 'object' &&
    data !== null &&
    'error' in data &&
    typeof (data as ApiError).error === 'object'
  );
}

export default function ComparePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const [sessionA, setSessionA] = useState(searchParams.get('a') ?? '');
  const [sessionB, setSessionB] = useState(searchParams.get('b') ?? '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [eligibilityDetails, setEligibilityDetails] = useState<
    Array<{ field: string; issue: string }>
  >([]);

  // Auto-trigger if both URL params present
  useEffect(() => {
    const a = searchParams.get('a');
    const b = searchParams.get('b');
    if (a && b) {
      setSessionA(a);
      setSessionB(b);
      runComparison(a, b);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runComparison(a: string, b: string) {
    setLoading(true);
    setError(null);
    setEligibilityDetails([]);
    try {
      const result = await createComparison(a, b);
      navigate(`/comparisons/${result.comparison_id}`);
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        const status = err.response?.status;
        const data = err.response?.data as unknown;
        if (status === 422 && isApiError(data) && data.error.code === 'COMPARISON_INELIGIBLE') {
          setError(data.error.message);
          setEligibilityDetails(data.error.details ?? []);
        } else if (status === 400 && isApiError(data)) {
          setError(data.error.message);
          setEligibilityDetails(data.error.details ?? []);
        } else if (status === 404 && isApiError(data)) {
          setError(data.error.message);
        } else if (status === 503) {
          setError('Backend unavailable. Please try again later.');
        } else {
          setError(`Comparison failed (${status ?? 'network error'}).`);
        }
      } else {
        setError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    await runComparison(sessionA.trim(), sessionB.trim());
  }

  return (
    <main className="page">
      <Link to="/" className="back-link">← Back to runs</Link>
      <h1>Compare Runs</h1>
      <p className="hint">
        Select two runs to compare their benchmark results. Session A is the baseline;
        Session B is the candidate.
      </p>

      <form onSubmit={handleSubmit} className="compare-form" noValidate>
        <div className="field">
          <label htmlFor="session-a">Session A (baseline)</label>
          <input
            id="session-a"
            type="text"
            value={sessionA}
            onChange={(e) => setSessionA(e.target.value)}
            placeholder="UUID"
            aria-label="Session A UUID"
            required
          />
        </div>
        <div className="field">
          <label htmlFor="session-b">Session B (candidate)</label>
          <input
            id="session-b"
            type="text"
            value={sessionB}
            onChange={(e) => setSessionB(e.target.value)}
            placeholder="UUID"
            aria-label="Session B UUID"
            required
          />
        </div>

        {error && (
          <div className="error-banner" role="alert">
            <p>{error}</p>
            {eligibilityDetails.length > 0 && (
              <ul className="eligibility-details">
                {eligibilityDetails.map((d, i) => (
                  <li key={i}>
                    <strong>{d.field}:</strong> {d.issue}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <button type="submit" disabled={loading} aria-busy={loading} className="btn">
          {loading ? 'Comparing…' : 'Compare'}
        </button>
      </form>
    </main>
  );
}
