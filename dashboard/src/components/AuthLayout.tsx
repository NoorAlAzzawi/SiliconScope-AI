import { Outlet } from 'react-router-dom';
import { useState } from 'react';
import { logout } from '../api/auth';
import { useAuth } from '../hooks/useAuth';

export default function AuthLayout() {
  const { setAuthenticated } = useAuth();
  const [logoutError, setLogoutError] = useState<string | null>(null);

  async function handleLogout() {
    setLogoutError(null);
    try {
      await logout();
      setAuthenticated(false);
    } catch {
      setLogoutError('Logout failed. Please try again.');
    }
  }

  return (
    <>
      <nav className="app-nav" aria-label="Application navigation">
        {logoutError && (
          <span role="alert" style={{ color: 'var(--color-error-text)', fontSize: '0.875rem' }}>
            {logoutError}
          </span>
        )}
        <button onClick={handleLogout} className="btn btn-outline">Log out</button>
      </nav>
      <Outlet />
    </>
  );
}
