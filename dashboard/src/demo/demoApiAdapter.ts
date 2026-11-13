import type { InternalAxiosRequestConfig, AxiosResponse } from 'axios';
import client from '../api/client';
import {
  DEMO_RUN_LIST,
  DEMO_RUN_BASELINE,
  DEMO_RUN_CANDIDATE,
  DEMO_COMPARISON,
  DEMO_SESSION_A_ID,
  DEMO_SESSION_B_ID,
  DEMO_COMPARISON_ID,
} from './fixtures';

function makeResponse(data: unknown, config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  return Promise.resolve({
    data,
    status: 200,
    statusText: 'OK',
    headers: {} as AxiosResponse['headers'],
    config,
    request: {},
  });
}

// Replaces the axios network adapter for all requests on the shared client.
// Any URL not explicitly handled below throws immediately — no fallthrough to
// the real network adapter. This guarantees the demo never contacts a backend.
client.defaults.adapter = function demoAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const method = (config.method ?? 'GET').toUpperCase();
  const url = config.url ?? '';

  if (method === 'GET'  && url === '/api/v1/runs')                                return makeResponse(DEMO_RUN_LIST, config);
  if (method === 'GET'  && url === `/api/v1/runs/${DEMO_SESSION_A_ID}`)           return makeResponse(DEMO_RUN_BASELINE, config);
  if (method === 'GET'  && url === `/api/v1/runs/${DEMO_SESSION_B_ID}`)           return makeResponse(DEMO_RUN_CANDIDATE, config);
  if (method === 'POST' && url === '/api/v1/comparisons')                         return makeResponse(DEMO_COMPARISON, config);
  if (method === 'GET'  && url === `/api/v1/comparisons/${DEMO_COMPARISON_ID}`)   return makeResponse(DEMO_COMPARISON, config);

  return Promise.reject(
    new Error(`Demo mode: unhandled API request: ${method} ${url}`),
  );
};
