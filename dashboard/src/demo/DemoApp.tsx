// Side-effect import: installs the fail-closed axios adapter before any component
// mounts and makes an API call. Must be the first import.
import './demoApiAdapter';

import { HashRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../hooks/useAuth';
import DemoLayout from './DemoLayout';
import RunsPage from '../pages/RunsPage';
import RunDetailPage from '../pages/RunDetailPage';
import ComparePage from '../pages/ComparePage';
import ComparisonResultPage from '../pages/ComparisonResultPage';

// Static auth value: isAuthenticated is always true in demo mode.
// useAuthProvider() is intentionally NOT called — it would fire checkAuth()
// against a backend that does not exist in the demo environment.
const DEMO_AUTH = {
  isAuthenticated: true as const,
  setAuthenticated: (_: boolean) => undefined,
};

export default function DemoApp() {
  return (
    <AuthContext.Provider value={DEMO_AUTH}>
      {/* HashRouter is the top-level router — App.tsx's BrowserRouter is not used */}
      <HashRouter>
        <Routes>
          <Route element={<DemoLayout />}>
            <Route path="/" element={<RunsPage />} />
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/comparisons/:id" element={<ComparisonResultPage />} />
          </Route>
        </Routes>
      </HashRouter>
    </AuthContext.Provider>
  );
}
