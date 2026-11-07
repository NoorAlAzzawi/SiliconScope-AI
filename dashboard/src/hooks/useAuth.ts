import { useState, useEffect, createContext, useContext } from 'react';
import { checkAuth } from '../api/auth';

interface AuthContextValue {
  isAuthenticated: boolean | null;
  setAuthenticated: (v: boolean) => void;
}

export const AuthContext = createContext<AuthContextValue>({
  isAuthenticated: null,
  setAuthenticated: () => undefined,
});

export function useAuthProvider(): AuthContextValue {
  const [isAuthenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    checkAuth().then(setAuthenticated);
  }, []);

  return { isAuthenticated, setAuthenticated };
}

export function useAuth(): AuthContextValue {
  return useContext(AuthContext);
}
