import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { login } from '../api/auth';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();
  const { setAuthenticated } = useAuth();

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await login(password);
      setAuthenticated(true);
      navigate('/');
    } catch (err: unknown) {
      if (axios.isAxiosError(err)) {
        if (err.response?.status === 401) {
          setError('Incorrect password.');
        } else if (err.response?.status === 503) {
          setError(
            'Backend unavailable. The dashboard password may not be configured (SSCOPE_DASHBOARD_PASSWORD not set).'
          );
        } else {
          setError(`Unexpected error (${err.response?.status ?? 'network'}).`);
        }
      } else {
        setError('Network error. Is the backend running?');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="login-page">
      <div className="login-card">
        <h1>SiliconScope AI</h1>
        <form onSubmit={handleSubmit} noValidate>
          <div className="field">
            <label htmlFor="password">Dashboard password</label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              aria-describedby={error ? 'login-error' : undefined}
              required
            />
          </div>
          {error && (
            <p id="login-error" className="error-message" role="alert">
              {error}
            </p>
          )}
          <button type="submit" disabled={loading} aria-busy={loading}>
            {loading ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}
