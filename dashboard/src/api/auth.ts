import axios from 'axios';
import client from './client';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

export async function login(password: string): Promise<void> {
  const body = new URLSearchParams();
  body.append('password', password);
  await axios.post(`${BASE_URL}/dashboard/login`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    withCredentials: true,
  });
}

export async function logout(): Promise<void> {
  await client.post('/dashboard/logout');
}

export async function checkAuth(): Promise<boolean> {
  try {
    await client.get('/api/v1/runs', { params: { page: 1, page_size: 1 } });
    return true;
  } catch (error: unknown) {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      return false;
    }
    // On network error or 503, treat as unauthenticated so ProtectedRoute
    // redirects to login; login page shows the 503 message.
    return false;
  }
}
