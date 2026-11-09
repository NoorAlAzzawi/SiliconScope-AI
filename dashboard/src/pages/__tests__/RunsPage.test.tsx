import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import RunsPage from '../RunsPage';

vi.mock('../../api/runs', () => ({
  getRuns: vi.fn(),
  getRun: vi.fn(),
}));

import * as runsApi from '../../api/runs';

const SESSION_A = 'aaaaaaaa-1111-4000-8000-aaaaaaaaaaaa';
const SESSION_B = 'bbbbbbbb-2222-4000-8000-bbbbbbbbbbbb';

const runListFixture = {
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
      primary_metric: null,
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
      primary_metric: null,
    },
  ],
  pagination: { page: 1, page_size: 25, total_count: 2, total_pages: 1 },
};

describe('RunsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows a spinner while loading', () => {
    vi.mocked(runsApi.getRuns).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    renderWithProviders(<RunsPage />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('renders the run list after a successful fetch', async () => {
    vi.mocked(runsApi.getRuns).mockResolvedValueOnce(runListFixture);
    renderWithProviders(<RunsPage />);

    await waitFor(() =>
      expect(screen.getByText('Baseline Run')).toBeInTheDocument(),
    );
    expect(screen.getByText('Candidate Run')).toBeInTheDocument();
  });

  it('shows an empty state when the API returns no runs', async () => {
    vi.mocked(runsApi.getRuns).mockResolvedValueOnce({
      data: [],
      pagination: { page: 1, page_size: 25, total_count: 0, total_pages: 0 },
    });
    renderWithProviders(<RunsPage />);

    await waitFor(() =>
      expect(
        screen.getByText('No benchmark runs found.'),
      ).toBeInTheDocument(),
    );
  });

  it('shows a 503 error banner and a Retry button on backend error', async () => {
    vi.mocked(runsApi.getRuns).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 503 } }),
    );
    renderWithProviders(<RunsPage />);

    await waitFor(() =>
      expect(
        screen.getByText('Backend unavailable. Please try again later.'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('allows selecting at most two runs via checkboxes', async () => {
    vi.mocked(runsApi.getRuns).mockResolvedValueOnce(runListFixture);
    renderWithProviders(<RunsPage />);
    await screen.findByText('Baseline Run');

    const checkboxes = screen.getAllByRole('checkbox');
    const user = userEvent.setup();

    await user.click(checkboxes[0]);
    expect(checkboxes[0]).toBeChecked();

    await user.click(checkboxes[1]);
    expect(checkboxes[1]).toBeChecked();

    // "Compare selected runs" button appears when two runs are selected
    expect(
      screen.getByRole('button', { name: 'Compare selected runs' }),
    ).toBeInTheDocument();
  });

  it('shows the pagination controls when total_pages > 1', async () => {
    vi.mocked(runsApi.getRuns).mockResolvedValueOnce({
      ...runListFixture,
      pagination: { page: 1, page_size: 25, total_count: 50, total_pages: 2 },
    });
    renderWithProviders(<RunsPage />);
    await screen.findByText('Baseline Run');

    const nav = screen.getByRole('navigation', { name: 'Pagination' });
    expect(within(nav).getByRole('button', { name: 'Next page' })).not.toBeDisabled();
    expect(within(nav).getByRole('button', { name: 'Previous page' })).toBeDisabled();
  });

  it('filters by source and re-fetches when the source dropdown changes', async () => {
    vi.mocked(runsApi.getRuns)
      .mockResolvedValueOnce(runListFixture)
      .mockResolvedValueOnce({ data: [], pagination: { page: 1, page_size: 25, total_count: 0, total_pages: 0 } });
    renderWithProviders(<RunsPage />);
    await screen.findByText('Baseline Run');

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by source' }),
      'synthetic',
    );

    await waitFor(() => expect(runsApi.getRuns).toHaveBeenCalledTimes(2));
    expect(vi.mocked(runsApi.getRuns).mock.calls[1][0]).toMatchObject({
      source: 'synthetic',
    });
  });
});
