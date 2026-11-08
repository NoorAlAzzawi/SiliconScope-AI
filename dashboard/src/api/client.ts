import axios from 'axios';

const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '';

const client = axios.create({
  baseURL: BASE_URL,
  withCredentials: true,
});

client.interceptors.response.use(
  (response) => response,
  (error: unknown) => {
    if (axios.isAxiosError(error) && error.response?.status === 401) {
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export default client;
