import { vi } from 'vitest';

export interface ProfileFixture {
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

export function profile(overrides: Partial<ProfileFixture> & { id: string; name: string }): ProfileFixture {
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

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export interface RecordedCall {
  method: string;
  path: string;
  body: unknown;
}

/** Minimal stateful stand-in for the Profile API, reached only through fetch. */
export function installBackend(initial: ProfileFixture[], extra?: (call: RecordedCall) => Response | undefined) {
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

    // Every connected Profile page asks for these; most tests have nothing to say about them
    if (method === 'GET' && /^\/api\/profiles\/[^/]+\/rules\/contacts$/.test(path)) return json([]);
    if (method === 'GET' && /^\/api\/profiles\/[^/]+\/discover\/contact-groups$/.test(path)) {
      return json({ apple: [], google: [] });
    }
    if (method === 'GET' && /^\/api\/profiles\/[^/]+\/delete-approvals$/.test(path)) return json([]);

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
