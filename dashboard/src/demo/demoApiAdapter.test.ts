import { describe, it, expect, beforeEach, vi } from 'vitest';
import './demoApiAdapter';
import { getRuns, getRun } from '../api/runs';
import { createComparison, getComparison } from '../api/comparisons';
import {
  DEMO_RUN_LIST,
  DEMO_RUN_BASELINE,
  DEMO_RUN_CANDIDATE,
  DEMO_COMPARISON,
  DEMO_SESSION_A_ID,
  DEMO_SESSION_B_ID,
  DEMO_COMPARISON_ID,
} from './fixtures';

describe('demoApiAdapter — matched routes return fixtures', () => {
  it('GET /api/v1/runs returns DEMO_RUN_LIST', async () => {
    const result = await getRuns();
    expect(result).toEqual(DEMO_RUN_LIST);
  });

  it('GET /api/v1/runs/:id for baseline returns DEMO_RUN_BASELINE', async () => {
    const result = await getRun(DEMO_SESSION_A_ID);
    expect(result).toEqual(DEMO_RUN_BASELINE);
  });

  it('GET /api/v1/runs/:id for candidate returns DEMO_RUN_CANDIDATE', async () => {
    const result = await getRun(DEMO_SESSION_B_ID);
    expect(result).toEqual(DEMO_RUN_CANDIDATE);
  });

  it('POST /api/v1/comparisons returns DEMO_COMPARISON', async () => {
    const result = await createComparison(DEMO_SESSION_A_ID, DEMO_SESSION_B_ID);
    expect(result).toEqual(DEMO_COMPARISON);
  });

  it('GET /api/v1/comparisons/:id returns DEMO_COMPARISON', async () => {
    const result = await getComparison(DEMO_COMPARISON_ID);
    expect(result).toEqual(DEMO_COMPARISON);
  });
});

describe('demoApiAdapter — fail-closed: unhandled requests throw', () => {
  it('unrecognized GET URL throws with "Demo mode: unhandled API request"', async () => {
    // Import client directly to send a raw request not covered by fixture map
    const client = (await import('../api/client')).default;
    await expect(client.get('/api/v1/unknown-endpoint')).rejects.toThrow(
      'Demo mode: unhandled API request: GET /api/v1/unknown-endpoint',
    );
  });

  it('unrecognized POST URL throws with "Demo mode: unhandled API request"', async () => {
    const client = (await import('../api/client')).default;
    await expect(client.post('/api/v1/unknown-endpoint', {})).rejects.toThrow(
      'Demo mode: unhandled API request: POST /api/v1/unknown-endpoint',
    );
  });

  it('GET /api/v1/runs/:id with unknown ID throws', async () => {
    await expect(getRun('nonexistent-session-id')).rejects.toThrow(
      'Demo mode: unhandled API request: GET /api/v1/runs/nonexistent-session-id',
    );
  });
});

describe('demoApiAdapter — no real network calls are made', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    vi.stubGlobal('XMLHttpRequest', vi.fn());
  });

  it('getRuns() does not invoke fetch or XMLHttpRequest', async () => {
    await getRuns();
    expect(fetch).not.toHaveBeenCalled();
    expect(XMLHttpRequest).not.toHaveBeenCalled();
  });

  it('getRun(baseline) does not invoke fetch or XMLHttpRequest', async () => {
    await getRun(DEMO_SESSION_A_ID);
    expect(fetch).not.toHaveBeenCalled();
    expect(XMLHttpRequest).not.toHaveBeenCalled();
  });

  it('createComparison() does not invoke fetch or XMLHttpRequest', async () => {
    await createComparison(DEMO_SESSION_A_ID, DEMO_SESSION_B_ID);
    expect(fetch).not.toHaveBeenCalled();
    expect(XMLHttpRequest).not.toHaveBeenCalled();
  });
});
