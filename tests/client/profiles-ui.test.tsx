// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));
import { redirectTo } from '../../src/client/lib/navigation.js';

interface ProfileFixture {
  id: string;
  name: string;
  enabled: boolean;
  appleId: string | null;
  appleConnected: boolean;
  googleConnected: boolean;
  googleReauthRequired: boolean;
  lastSyncAt: number | null;
  lastSyncStatus: string | null;
}

function profile(overrides: Partial<ProfileFixture> & { id: string; name: string }): ProfileFixture {
  return {
    enabled: true,
    appleId: null,
    appleConnected: false,
    googleConnected: false,
    googleReauthRequired: false,
    lastSyncAt: null,
    lastSyncStatus: null,
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** Minimal stateful stand-in for the Profile API, reached only through fetch. */
function installBackend(initial: ProfileFixture[], extra?: (call: RecordedCall) => Response | undefined) {
  const profiles = [...initial];
  const calls: RecordedCall[] = [];
  let nextId = 100;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, path, body };
    calls.push(call);

    const override = extra?.(call);
    if (override) {
      return override;
    }

    if (path === '/api/auth/me') return json({ username: 'admin' });
    if (path === '/api/auth/logout') return json({ ok: true });
    if (path === '/api/profiles' && method === 'GET') return json(profiles);
    if (path === '/api/profiles' && method === 'POST') {
      const created = profile({ id: `p${nextId++}`, name: (body as { name: string }).name });
      profiles.push(created);
      return json(created, 201);
    }
    const match = /^\/api\/profiles\/([^/]+)$/.exec(path);
    if (match) {
      const index = profiles.findIndex((p) => p.id === match[1]);
      if (index < 0) return json({ error: 'Profile not found' }, 404);
      if (method === 'PATCH') {
        profiles[index] = { ...profiles[index], ...(body as object) };
        return json(profiles[index]);
      }
      if (method === 'DELETE') {
        profiles.splice(index, 1);
        return new Response(null, { status: 204 });
      }
    }
    return json({ error: `Unhandled ${method} ${path}` }, 500);
  });

  vi.stubGlobal('fetch', fetchMock);
  return { profiles, calls };
}

describe('Profile management UI (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows an empty state and creates the first Profile from the top-bar switcher', async () => {
    const user = userEvent.setup();
    const backend = installBackend([]);
    render(<App />);

    expect(await screen.findByText(/no profiles yet/i)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/new profile name/i), '  Anna ');
    await user.click(screen.getByRole('button', { name: /add profile/i }));

    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();
    expect(backend.calls.find((c) => c.method === 'POST')?.body).toEqual({ name: 'Anna' });
    expect(screen.getByRole('combobox', { name: /profile/i })).toHaveDisplayValue('Anna');
  });

  it('switches between Profiles in the top bar', async () => {
    const user = userEvent.setup();
    installBackend([profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })]);
    render(<App />);

    expect(await screen.findByRole('heading', { name: 'Anna' })).toBeInTheDocument();

    await user.selectOptions(screen.getByRole('combobox', { name: /profile/i }), 'b');

    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
  });

  it('renames, pauses and re-activates the selected Profile', async () => {
    const user = userEvent.setup();
    const backend = installBackend([profile({ id: 'a', name: 'Anna' })]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Anna' });

    const nameInput = screen.getByLabelText(/^profile name$/i);
    await user.clear(nameInput);
    await user.type(nameInput, 'Anna K.');
    await user.click(screen.getByRole('button', { name: /^rename$/i }));
    expect(await screen.findByRole('heading', { name: 'Anna K.' })).toBeInTheDocument();
    expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Anna K.' });

    await user.click(screen.getByRole('button', { name: /^pause$/i }));
    expect(await screen.findByText(/paused/i)).toBeInTheDocument();
    expect(backend.profiles[0].enabled).toBe(false);

    await user.click(screen.getByRole('button', { name: /^activate$/i }));
    await screen.findByRole('button', { name: /^pause$/i });
    expect(backend.profiles[0].enabled).toBe(true);
  });

  it('deletes a Profile only after confirmation and falls back to the next Profile', async () => {
    const user = userEvent.setup();
    const backend = installBackend([profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })]);
    render(<App />);
    await screen.findByRole('heading', { name: 'Anna' });

    await user.click(screen.getByRole('button', { name: /delete profile/i }));
    expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);

    await user.click(screen.getByRole('button', { name: /confirm delete/i }));

    expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
    const options = within(screen.getByRole('combobox', { name: /profile/i })).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Ben']);
  });

  describe('Apple connection', () => {
    it('saves Apple credentials without keeping the password and shows per-protocol test results', async () => {
      const user = userEvent.setup();
      const connected = profile({
        id: 'a',
        name: 'Anna',
        appleId: 'anna@icloud.com',
        appleConnected: true,
      });
      const backend = installBackend([profile({ id: 'a', name: 'Anna' })], (call) => {
        if (call.method === 'PATCH' && call.path === '/api/profiles/a') return json(connected);
        if (call.method === 'POST' && call.path === '/api/profiles/a/test-apple') {
          return json({
            ok: false,
            caldav: { ok: true },
            carddav: { ok: true },
            imap: { ok: false, error: 'IMAP login rejected' },
          });
        }
        return undefined;
      });
      render(<App />);
      await screen.findByRole('heading', { name: 'Anna' });
      expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();

      await user.type(screen.getByLabelText(/apple id/i), 'anna@icloud.com');
      await user.type(screen.getByLabelText(/app-specific password/i), 'abcd-efgh-ijkl-mnop');
      await user.click(screen.getByRole('button', { name: /save apple credentials/i }));

      expect(await screen.findByText(/connected as anna@icloud\.com/i)).toBeInTheDocument();
      expect(backend.calls.find((c) => c.method === 'PATCH')?.body).toEqual({
        appleId: 'anna@icloud.com',
        appleAppPassword: 'abcd-efgh-ijkl-mnop',
      });
      expect(screen.getByLabelText(/app-specific password/i)).toHaveValue('');

      await user.click(screen.getByRole('button', { name: /test connection/i }));

      const results = await screen.findByRole('list', { name: /connection results/i });
      const items = within(results).getAllByRole('listitem');
      expect(items.map((item) => item.textContent)).toEqual([
        expect.stringMatching(/CalDAV.*Passed/),
        expect.stringMatching(/CardDAV.*Passed/),
        expect.stringMatching(/IMAP.*Failed.*IMAP login rejected/),
      ]);
    });
  });

  describe('Google connection', () => {
    it('starts the Google consent flow from the Connect button', async () => {
      const user = userEvent.setup();
      installBackend([profile({ id: 'a', name: 'Anna' })], (call) =>
        call.path === '/api/profiles/a/google/auth-url'
          ? json({ url: 'https://accounts.google.test/auth?state=s1' })
          : undefined,
      );
      render(<App />);
      await screen.findByRole('heading', { name: 'Anna' });
      expect(screen.getByText(/google account not connected/i)).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /connect google/i }));

      await waitFor(() =>
        expect(redirectTo).toHaveBeenCalledWith('https://accounts.google.test/auth?state=s1'),
      );
    });

    it('shows a re-authentication warning when Google reported invalid_grant', async () => {
      installBackend([
        profile({ id: 'a', name: 'Anna', googleConnected: true, googleReauthRequired: true }),
      ]);
      render(<App />);

      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent(/re-authenticate/i);
      expect(screen.getByRole('button', { name: /reconnect google/i })).toBeInTheDocument();
    });

    it('reports the outcome of the OAuth redirect from the URL', async () => {
      window.history.replaceState({}, '', '/?profile=b&google=connected');
      installBackend([
        profile({ id: 'a', name: 'Anna' }),
        profile({ id: 'b', name: 'Ben', googleConnected: true }),
      ]);
      render(<App />);

      expect(await screen.findByRole('heading', { name: 'Ben' })).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/google account connected/i);
    });

    it('shows an error when linking was denied or failed', async () => {
      window.history.replaceState({}, '', '/?profile=a&google=error');
      installBackend([profile({ id: 'a', name: 'Anna' })]);
      render(<App />);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent(/could not connect google/i);
    });
  });

  describe('Auth Setup (trigger token)', () => {
    it('reveals the trigger token on demand and shows the new token after rotation', async () => {
      const user = userEvent.setup();
      const backend = installBackend([profile({ id: 'a', name: 'Anna' })], (call) => {
        if (call.method === 'GET' && call.path === '/api/profiles/a/trigger-token') {
          return json({ token: 'old-token-value' });
        }
        if (call.method === 'POST' && call.path === '/api/profiles/a/rotate-trigger-token') {
          return json({ token: 'new-token-value' });
        }
        return undefined;
      });
      render(<App />);
      await screen.findByRole('heading', { name: 'Anna' });

      expect(screen.queryByText('old-token-value')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: /show trigger token/i }));
      expect(await screen.findByText('old-token-value')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /rotate token/i }));

      expect(await screen.findByText('new-token-value')).toBeInTheDocument();
      expect(screen.queryByText('old-token-value')).not.toBeInTheDocument();
      expect(backend.calls.some((c) => c.path === '/api/profiles/a/rotate-trigger-token')).toBe(true);
    });
  });
});
