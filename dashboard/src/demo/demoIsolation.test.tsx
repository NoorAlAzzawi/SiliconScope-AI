/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { AuthContext } from '../hooks/useAuth';
import ProtectedRoute from '../components/ProtectedRoute';

const __filename = fileURLToPath(import.meta.url);
const __dirname_local = path.dirname(__filename);

const SRC_DIR = path.resolve(__dirname_local, '..');
const DEMO_DIR = path.resolve(__dirname_local);

function collectSourceFiles(dir: string, results: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full === DEMO_DIR) continue; // skip src/demo/ itself
      collectSourceFiles(full, results);
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

describe('Source-level demo isolation', () => {
  it('no production source file contains a static import from the demo/ directory', () => {
    const files = collectSourceFiles(SRC_DIR);
    const violations: string[] = [];

    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      // Allow dynamic import('./demo/...') in main.tsx; forbid static imports
      const staticDemoImport = /^import\s+[^(].*['"].*\/demo\//m;
      if (staticDemoImport.test(content)) {
        violations.push(path.relative(SRC_DIR, file));
      }
    }

    expect(violations).toHaveLength(0);
  });

  it('main.tsx uses a dynamic import for DemoApp, not a static import', () => {
    const mainPath = path.resolve(SRC_DIR, 'main.tsx');
    const content = fs.readFileSync(mainPath, 'utf8');

    expect(content).toContain("import('./demo/DemoApp')");
    expect(content).not.toMatch(/^import\s+DemoApp\s+from/m);
  });

  it('VITE_DEMO_MODE is not set to true in .env (would infect production dev server)', () => {
    const envPath = path.resolve(SRC_DIR, '../../.env');
    if (!fs.existsSync(envPath)) return; // no .env file — pass
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).not.toMatch(/^VITE_DEMO_MODE\s*=\s*true/m);
  });

  it('VITE_DEMO_MODE is not set to true in .env.production', () => {
    const envPath = path.resolve(SRC_DIR, '../../.env.production');
    if (!fs.existsSync(envPath)) return; // no .env.production file — pass
    const content = fs.readFileSync(envPath, 'utf8');
    expect(content).not.toMatch(/^VITE_DEMO_MODE\s*=\s*true/m);
  });
});

describe('Production authentication is still enforced', () => {
  it('ProtectedRoute redirects unauthenticated users to /login', () => {
    render(
      <AuthContext.Provider
        value={{ isAuthenticated: false, setAuthenticated: () => undefined }}
      >
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProtectedRoute />}>
              <Route index element={<div>Protected content</div>} />
            </Route>
            <Route path="/login" element={<div data-testid="login-page">Login</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getByTestId('login-page')).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });

  it('ProtectedRoute renders protected content when authenticated', () => {
    render(
      <AuthContext.Provider
        value={{ isAuthenticated: true, setAuthenticated: () => undefined }}
      >
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProtectedRoute />}>
              <Route index element={<div>Protected content</div>} />
            </Route>
            <Route path="/login" element={<div>Login</div>} />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getByText('Protected content')).toBeInTheDocument();
    expect(screen.queryByText('Login')).not.toBeInTheDocument();
  });

  it('ProtectedRoute shows spinner when auth state is null (initial loading state)', () => {
    render(
      <AuthContext.Provider
        value={{ isAuthenticated: null, setAuthenticated: () => undefined }}
      >
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<ProtectedRoute />}>
              <Route index element={<div>Protected content</div>} />
            </Route>
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>,
    );

    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
    expect(screen.queryByText('Protected content')).not.toBeInTheDocument();
  });
});
