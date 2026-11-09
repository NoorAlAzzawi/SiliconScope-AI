import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import LoginPage from '../LoginPage';

vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  checkAuth: vi.fn(),
}));

import * as authApi from '../../api/auth';

function axiosError(status: number) {
  return Object.assign(new Error(), { isAxiosError: true, response: { status } });
}

function networkError() {
  return Object.assign(new Error(), { isAxiosError: true, response: undefined });
}

describe('LoginPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the password field and sign-in button', () => {
    renderWithProviders(<LoginPage />, { isAuthenticated: false });
    expect(screen.getByLabelText('Dashboard password')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('calls login with the entered password on submit', async () => {
    vi.mocked(authApi.login).mockResolvedValueOnce(undefined);
    const setAuthenticated = vi.fn();
    renderWithProviders(<LoginPage />, { isAuthenticated: false, setAuthenticated });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dashboard password'), 'correct-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(authApi.login).toHaveBeenCalledWith('correct-password'),
    );
    expect(setAuthenticated).toHaveBeenCalledWith(true);
  });

  it('shows "Incorrect password." on 401', async () => {
    vi.mocked(authApi.login).mockRejectedValueOnce(axiosError(401));
    renderWithProviders(<LoginPage />, { isAuthenticated: false });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dashboard password'), 'wrong');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Incorrect password.'),
    );
  });

  it('shows backend unavailable message on 503', async () => {
    vi.mocked(authApi.login).mockRejectedValueOnce(axiosError(503));
    renderWithProviders(<LoginPage />, { isAuthenticated: false });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dashboard password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Backend unavailable'),
    );
  });

  it('shows a network error message when no response is received', async () => {
    vi.mocked(authApi.login).mockRejectedValueOnce(networkError());
    renderWithProviders(<LoginPage />, { isAuthenticated: false });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dashboard password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Unexpected error (network)',
      ),
    );
  });

  it('disables the submit button while a login request is in flight', async () => {
    vi.mocked(authApi.login).mockImplementationOnce(
      () => new Promise<void>(() => undefined),
    );
    renderWithProviders(<LoginPage />, { isAuthenticated: false });
    const user = userEvent.setup();

    await user.type(screen.getByLabelText('Dashboard password'), 'x');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(screen.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
  });
});
