import { type ReactElement } from 'react';
import { render } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../hooks/useAuth';

interface AuthOptions {
  isAuthenticated?: boolean | null;
  setAuthenticated?: (v: boolean) => void;
}

export function renderWithProviders(
  ui: ReactElement,
  {
    isAuthenticated = true,
    setAuthenticated = () => undefined,
    initialEntries,
  }: AuthOptions & { initialEntries?: string[] } = {},
) {
  return render(
    <AuthContext.Provider value={{ isAuthenticated, setAuthenticated }}>
      <MemoryRouter initialEntries={initialEntries ?? ['/']}>
        {ui}
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}

export function renderWithRoute(
  ui: ReactElement,
  routePath: string,
  initialPath: string,
  authOptions: AuthOptions = {},
) {
  const { isAuthenticated = true, setAuthenticated = () => undefined } = authOptions;
  return render(
    <AuthContext.Provider value={{ isAuthenticated, setAuthenticated }}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path={routePath} element={ui} />
        </Routes>
      </MemoryRouter>
    </AuthContext.Provider>,
  );
}
