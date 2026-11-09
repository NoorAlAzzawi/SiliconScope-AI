import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithRoute } from '../../test-utils/renderWithProviders';
import RunDetailPage from '../RunDetailPage';

vi.mock('../../api/runs', () => ({
  getRuns: vi.fn(),
  getRun: vi.fn(),
}));

import * as runsApi from '../../api/runs';

const SESSION_ID = 'aaaaaaaa-1111-4000-8000-aaaaaaaaaaaa';

const runDetailFixture = {
  session_id: SESSION_ID,
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

describe('RunDetailPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function render(initialPath = `/runs/${SESSION_ID}`) {
    return renderWithRoute(
      <RunDetailPage />,
      '/runs/:id',
      initialPath,
    );
  }

  it('shows a spinner while the run is loading', () => {
    vi.mocked(runsApi.getRun).mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    render();
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('renders the run name and metadata after a successful fetch', async () => {
    vi.mocked(runsApi.getRun).mockResolvedValueOnce(runDetailFixture);
    render();

    const heading = await screen.findByRole('heading', { name: 'Baseline Run' });
    expect(heading).toBeInTheDocument();
    expect(screen.getByText('Apple M3')).toBeInTheDocument();
    expect(screen.getByText('arm64')).toBeInTheDocument();
  });

  it('renders the benchmark cases table', async () => {
    vi.mocked(runsApi.getRun).mockResolvedValueOnce(runDetailFixture);
    render();

    await screen.findByRole('heading', { name: 'Baseline Run' });
    expect(screen.getByText('BM_cpu_integer')).toBeInTheDocument();
    expect(screen.getByText('BM_cpu_float')).toBeInTheDocument();
  });

  it('shows "Run not found." on 404', async () => {
    vi.mocked(runsApi.getRun).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 404 } }),
    );
    render();

    await waitFor(() =>
      expect(screen.getByText('Run not found.')).toBeInTheDocument(),
    );
  });

  it('shows a backend unavailable error on 503', async () => {
    vi.mocked(runsApi.getRun).mockRejectedValueOnce(
      Object.assign(new Error(), { isAxiosError: true, response: { status: 503 } }),
    );
    render();

    await waitFor(() =>
      expect(
        screen.getByText('Backend unavailable. Please try again later.'),
      ).toBeInTheDocument(),
    );
  });

  it('calls getRun with the session ID from the URL', async () => {
    vi.mocked(runsApi.getRun).mockResolvedValueOnce(runDetailFixture);
    render();

    await waitFor(() => expect(runsApi.getRun).toHaveBeenCalledWith(SESSION_ID));
  });
});
