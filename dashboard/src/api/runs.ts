import type { RunListResponse, RunDetail } from '../types';
import client from './client';

export interface RunListParams {
  page?: number;
  page_size?: number;
  source?: string;
  date_from?: string;
  date_to?: string;
  q?: string;
}

export async function getRuns(params: RunListParams = {}): Promise<RunListResponse> {
  const res = await client.get<RunListResponse>('/api/v1/runs', { params });
  return res.data;
}

export async function getRun(id: string): Promise<RunDetail> {
  const res = await client.get<RunDetail>(`/api/v1/runs/${id}`);
  return res.data;
}
