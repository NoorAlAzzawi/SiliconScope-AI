import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithRoute } from '../../test-utils/renderWithProviders';
import ComparisonResultPage from '../ComparisonResultPage';

vi.mock('../../api/comparisons', () => ({
  createComparison: vi.fn(),
  getComparison: vi.fn(),
}));

import * as comparisonsApi from '../../api/comparisons';

const SESSION_A = 'aaaaaaaa-1111-4000-8000-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-2222-4000-8000-bbbbbbbbbbbb';
const COMPARISON_ID = 'cccccccc-3333-4000-8000-cccccccccccc';

const comparisonFixture = {
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

describe('ComparisonResultPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/mock');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  function render(id = COMPARISON_ID) {
    return renderWithRoute(
      <ComparisonResultPage />,
      '/comparisons/:id',
      `/comparisons/${id}`,
    );
  }

  it('shows a spinner while loading', () => {
    vi.mocked(comparisonsApi.getComparison).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('renders the overall summary label after a successful fetch', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Regression detected'),
    );
  });

  it('renders the per-metric results table', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();

    await screen.findByRole('status');
    expect(screen.getByRole('cell', { name: 'BM_cpu_integer' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: 'C1' })).toBeInTheDocument();
    expect(screen.getByRole('cell', { name: '+48.00%' })).toBeInTheDocument();
  });

  it('renders the automated summary section', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();

    await screen.findByRole('status');
    expect(
      screen.getByText('Major regression detected in BM_cpu_integer.'),
    ).toBeInTheDocument();
  });

  it('renders the Export JSON button', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();

    await screen.findByRole('status');
    expect(
      screen.getByRole('button', { name: 'Export comparison as JSON' }),
    ).toBeInTheDocument();
  });

  it('calls URL.createObjectURL when Export JSON is clicked', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();
    await screen.findByRole('status');

    await userEvent.click(
      screen.getByRole('button', { name: 'Export comparison as JSON' }),
    );

    expect(URL.createObjectURL).toHaveBeenCalledOnce();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:http://localhost/mock');
  });

  it('shows "Comparison not found." on 404', async () => {
    vi.mocked(comparisonsApi.getComparison).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 404 } }),
    );
    render();

    await waitFor(() =>
      expect(screen.getByText('Comparison not found.')).toBeInTheDocument(),
    );
  });

  it('shows a backend unavailable error on 503', async () => {
    vi.mocked(comparisonsApi.getComparison).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 503 } }),
    );
    render();

    await waitFor(() =>
      expect(
        screen.getByText('Backend unavailable. Please try again later.'),
      ).toBeInTheDocument(),
    );
  });

  it('calls getComparison with the comparison ID from the URL', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    render();

    await waitFor(() =>
      expect(comparisonsApi.getComparison).toHaveBeenCalledWith(COMPARISON_ID),
    );
  });

  it('renders baseline and candidate mean columns', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(comparisonFixture);
    render();
    await screen.findByRole('status');

    expect(screen.getByRole('columnheader', { name: 'Baseline Mean' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Candidate Mean' })).toBeInTheDocument();
    // 125_000_000 ns = 125.000 ms
    expect(screen.getByRole('cell', { name: '125.000 ms' })).toBeInTheDocument();
    // 185_000_000 ns = 185.000 ms
    expect(screen.getByRole('cell', { name: '185.000 ms' })).toBeInTheDocument();
  });

  it('renders — for mean columns when mean fields are absent (old JSONB backward compat)', async () => {
    const pmr = { ...comparisonFixture.per_metric_results[0] };
    // Simulate old JSONB record that lacks mean fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (pmr as any).mean_baseline_ns;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (pmr as any).mean_candidate_ns;
    const oldFixture = { ...comparisonFixture, per_metric_results: [pmr] };
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      oldFixture as unknown as typeof comparisonFixture,
    );
    render();
    await screen.findByRole('status');

    // Both mean cells should show — without throwing
    const meanCells = screen.getAllByRole('cell', { name: '—' });
    expect(meanCells.length).toBeGreaterThanOrEqual(2);
  });

  it('renders caveats row when caveats are non-empty', async () => {
    const fixtureWithCaveats = {
      ...comparisonFixture,
      per_metric_results: [
        {
          ...comparisonFixture.per_metric_results[0],
          caveats: ['High variance detected (baseline CV=12.3%). Detection sensitivity is reduced.'],
        },
      ],
    };
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(fixtureWithCaveats);
    render();
    await screen.findByRole('status');

    expect(
      screen.getByText('High variance detected (baseline CV=12.3%). Detection sensitivity is reduced.'),
    ).toBeInTheDocument();
  });

  it('does not render a caveats row when caveats is empty', async () => {
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(comparisonFixture);
    render();
    await screen.findByRole('status');

    expect(screen.queryByRole('list')).not.toBeInTheDocument();
  });

  it('does not throw when caveats field is absent (old JSONB backward compat)', async () => {
    const pmr = { ...comparisonFixture.per_metric_results[0] };
    // Simulate old JSONB record that lacks caveats field
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (pmr as any).caveats;
    const fixtureNoCaveats = { ...comparisonFixture, per_metric_results: [pmr] };
    vi.mocked(comparisonsApi.getComparison).mockResolvedValueOnce(
      fixtureNoCaveats as unknown as typeof comparisonFixture,
    );
    render();
    // Should render successfully without errors
    await screen.findByRole('status');
    expect(screen.getByRole('cell', { name: 'BM_cpu_integer' })).toBeInTheDocument();
  });
});
