// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('Auth UI (fetch boundary)', () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
    window.history.replaceState({}, '', '/login');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('renders the Login screen when unauthenticated and transitions to the authenticated shell on valid login', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/login?next=%2Fprofiles');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ username: 'admin' }, 200))
      .mockResolvedValueOnce(jsonResponse([], 200));

    render(<App />);

    expect(await screen.findByRole('heading', { name: /sign in/i })).toBeInTheDocument();

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'secret-password');
    await user.type(screen.getByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByText('admin')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /log out/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/profiles');

    const [, loginInit] = fetchMock.mock.calls[1];
    expect(loginInit?.method).toBe('POST');
    expect(JSON.parse(String(loginInit?.body))).toEqual({
      username: 'admin',
      password: 'secret-password',
      totpCode: '123456',
    });
  });

  it('displays credential error feedback on 401 login failure', async () => {
    const user = userEvent.setup();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ error: 'Invalid credentials' }, 401));

    render(<App />);
    await screen.findByRole('heading', { name: /sign in/i });

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'wrong');
    await user.type(screen.getByLabelText(/authenticator code/i), '654321');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/invalid credentials/i);
  });

  it('displays lockout feedback with retry duration when login returns 429', async () => {
    const user = userEvent.setup();

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: 'Too many failed verification attempts. Try again later.',
            retryAfterSeconds: 900,
            lockedUntil: Date.now() + 900_000,
          },
          429,
        ),
      );

    render(<App />);
    await screen.findByRole('heading', { name: /sign in/i });

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'secret-password');
    await user.type(screen.getByLabelText(/authenticator code/i), '000000');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/locked|too many failed/i);
    expect(alert).toHaveTextContent(/15\s*min/i);
  });

  it('prevents open redirects on the client next parameter after login', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/login?next=https%3A%2F%2Fevil.example.com');

    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: 'Unauthorized' }, 401))
      .mockResolvedValueOnce(jsonResponse({ username: 'admin' }, 200))
      .mockResolvedValueOnce(jsonResponse([], 200));

    render(<App />);
    await screen.findByRole('heading', { name: /sign in/i });

    await user.type(screen.getByLabelText(/username/i), 'admin');
    await user.type(screen.getByLabelText(/password/i), 'secret-password');
    await user.type(screen.getByLabelText(/authenticator code/i), '123456');
    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await screen.findByRole('button', { name: /log out/i });
    expect(window.location.pathname).toBe('/');
  });

  it('renders the authenticated shell when already signed in and returns to Login on Logout', async () => {
    const user = userEvent.setup();
    window.history.replaceState({}, '', '/');

    // The shell loads its pages on its own, so answer by path instead of in call order
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/auth/me') return jsonResponse({ username: 'admin' }, 200);
      if (path === '/api/auth/logout') return jsonResponse({ ok: true }, 200);
      return jsonResponse([], 200);
    });

    render(<App />);

    expect(await screen.findByText('admin')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /log out/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /sign in/i })).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe('/login');
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/logout', expect.objectContaining({ method: 'POST' }));
  });
});
