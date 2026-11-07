import type { ComparisonResult } from '../types';
import client from './client';

export async function createComparison(
  session_a_id: string,
  session_b_id: string
): Promise<ComparisonResult> {
  const res = await client.post<ComparisonResult>('/api/v1/comparisons', {
    session_a_id,
    session_b_id,
  });
  return res.data;
}

export async function getComparison(id: string): Promise<ComparisonResult> {
  const res = await client.get<ComparisonResult>(`/api/v1/comparisons/${id}`);
  return res.data;
}
