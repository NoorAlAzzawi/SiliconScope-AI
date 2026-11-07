import { Navigate, Outlet } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import Spinner from './Spinner';

export default function ProtectedRoute() {
  const { isAuthenticated } = useAuth();

  if (isAuthenticated === null) {
    return (
      <main className="page-center">
        <Spinner />
      </main>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <Outlet />;
}
