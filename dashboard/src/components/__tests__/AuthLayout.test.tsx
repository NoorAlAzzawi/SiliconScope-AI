import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from '../../test-utils/renderWithProviders';
import AuthLayout from '../AuthLayout';

vi.mock('../../api/auth', () => ({
  login: vi.fn(),
  logout: vi.fn(),
  checkAuth: vi.fn(),
}));

import * as authApi from '../../api/auth';

describe('AuthLayout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the Log out button in the navigation', () => {
    renderWithProviders(<AuthLayout />);
    expect(
      screen.getByRole('button', { name: 'Log out' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('calls logout and sets authenticated to false on successful logout', async () => {
    vi.mocked(authApi.logout).mockResolvedValueOnce(undefined);
    const setAuthenticated = vi.fn();
    renderWithProviders(<AuthLayout />, { setAuthenticated });

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() => expect(authApi.logout).toHaveBeenCalledOnce());
    expect(setAuthenticated).toHaveBeenCalledWith(false);
  });

  it('shows an inline error when logout fails', async () => {
    vi.mocked(authApi.logout).mockRejectedValueOnce(new Error('network error'));
    renderWithProviders(<AuthLayout />);

    await userEvent.click(screen.getByRole('button', { name: 'Log out' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Logout failed. Please try again.',
      ),
    );
  });

  it('clears the error on a subsequent successful logout', async () => {
    vi.mocked(authApi.logout)
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce(undefined);
    renderWithProviders(<AuthLayout />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await screen.findByRole('alert');

    await user.click(screen.getByRole('button', { name: 'Log out' }));
    await waitFor(() =>
      expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
    );
  });
});
