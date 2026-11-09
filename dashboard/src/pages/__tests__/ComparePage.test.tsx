import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import ComparePage from '../ComparePage';

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
  per_metric_results: [],
  overall_summary: { label: 'No regression', k1: 0, k2: 0, k3: 0, k4: 0, m: 0 },
  rule_based_explanation: 'No significant changes detected.',
};

function axiosError(status: number, code?: string, message?: string) {
  const details = code ? { code, message: message ?? 'error', details: [] } : undefined;
  return Object.assign(new Error(), {
    isAxiosError: true,
    response: { status, data: details ? { error: details } : undefined },
  });
}

describe('ComparePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders two UUID input fields and a Compare button', () => {
    renderWithProviders(<ComparePage />);
    expect(screen.getByLabelText('Session A UUID')).toBeInTheDocument();
    expect(screen.getByLabelText('Session B UUID')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument();
  });

  it('pre-fills inputs from ?a= and ?b= search params', () => {
    renderWithProviders(<ComparePage />, {
      initialEntries: [`/compare?a=${SESSION_A}&b=${SESSION_B}`],
    });
    expect(screen.getByLabelText('Session A UUID')).toHaveValue(SESSION_A);
    expect(screen.getByLabelText('Session B UUID')).toHaveValue(SESSION_B);
  });

  it('auto-triggers the comparison when both search params are present', async () => {
    vi.mocked(comparisonsApi.createComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    renderWithProviders(<ComparePage />, {
      initialEntries: [`/compare?a=${SESSION_A}&b=${SESSION_B}`],
    });

    await waitFor(() =>
      expect(comparisonsApi.createComparison).toHaveBeenCalledWith(
        SESSION_A,
        SESSION_B,
      ),
    );
  });

  it('calls createComparison with trimmed UUIDs on form submit', async () => {
    vi.mocked(comparisonsApi.createComparison).mockResolvedValueOnce(
      comparisonFixture,
    );
    renderWithProviders(<ComparePage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Session A UUID'), ` ${SESSION_A} `);
    await user.type(screen.getByLabelText('Session B UUID'), SESSION_B);
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    await waitFor(() =>
      expect(comparisonsApi.createComparison).toHaveBeenCalledWith(
        SESSION_A,
        SESSION_B,
      ),
    );
  });

  it('shows the backend error message on 400', async () => {
    vi.mocked(comparisonsApi.createComparison).mockRejectedValueOnce(
      axiosError(400, 'VALIDATION_ERROR', 'session_a_id must be a UUID'),
    );
    renderWithProviders(<ComparePage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Session A UUID'), 'not-a-uuid');
    await user.type(screen.getByLabelText('Session B UUID'), SESSION_B);
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'session_a_id must be a UUID',
      ),
    );
  });

  it('shows the backend error message on 404', async () => {
    vi.mocked(comparisonsApi.createComparison).mockRejectedValueOnce(
      axiosError(404, 'NOT_FOUND', 'Session not found'),
    );
    renderWithProviders(<ComparePage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Session A UUID'), SESSION_A);
    await user.type(screen.getByLabelText('Session B UUID'), SESSION_B);
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Session not found'),
    );
  });

  it('shows a backend unavailable error on 503', async () => {
    vi.mocked(comparisonsApi.createComparison).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 503 } }),
    );
    renderWithProviders(<ComparePage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Session A UUID'), SESSION_A);
    await user.type(screen.getByLabelText('Session B UUID'), SESSION_B);
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Backend unavailable',
      ),
    );
  });

  it('disables the Compare button while a request is in flight', async () => {
    vi.mocked(comparisonsApi.createComparison).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    renderWithProviders(<ComparePage />);
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Session A UUID'), SESSION_A);
    await user.type(screen.getByLabelText('Session B UUID'), SESSION_B);
    await user.click(screen.getByRole('button', { name: 'Compare' }));

    expect(screen.getByRole('button', { name: 'Comparing…' })).toBeDisabled();
  });
});
