import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '../../src/server/crypto/secrets.js';
import { createTestContext, type TestContext } from '../helpers/test-app.js';

interface ProfileJson {
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

describe('Profile management HTTP seam', () => {
  let ctx: TestContext | undefined;
  let cookie = '';

  afterEach(() => {
    ctx?.close();
    ctx = undefined;
  });

  async function setup(): Promise<TestContext> {
    ctx = createTestContext();
    cookie = await ctx.signIn();
    return ctx;
  }

  function api(path: string, init?: { method?: string; body?: unknown; cookie?: string | null }) {
    const headers: Record<string, string> = {};
    const sessionCookie = init?.cookie === undefined ? cookie : init.cookie;
    if (sessionCookie) {
      headers.cookie = sessionCookie;
    }
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return ctx!.app.request(path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async function createProfile(name: string): Promise<ProfileJson> {
    const res = await api('/api/profiles', { method: 'POST', body: { name } });
    expect(res.status).toBe(201);
    return (await res.json()) as ProfileJson;
  }

  it('requires an admin session for every profile route', async () => {
    await setup();

    const list = await api('/api/profiles', { cookie: null });
    expect(list.status).toBe(401);
    const create = await api('/api/profiles', { method: 'POST', body: { name: 'x' }, cookie: null });
    expect(create.status).toBe(401);
  });

  it('creates Profiles that start active and unconnected, and lists them in creation order', async () => {
    await setup();

    const anna = await createProfile('  Anna  ');
    const ben = await createProfile('Ben');

    expect(anna).toMatchObject({
      name: 'Anna',
      enabled: true,
      appleId: null,
      appleConnected: false,
      googleConnected: false,
      googleReauthRequired: false,
      lastSyncAt: null,
      lastSyncStatus: null,
    });
    expect(anna.id).not.toBe(ben.id);

    const list = await api('/api/profiles');
    expect(list.status).toBe(200);
    const profiles = (await list.json()) as ProfileJson[];
    expect(profiles.map((p) => p.name)).toEqual(['Anna', 'Ben']);
  });

  it('renames and pauses/activates a Profile without touching other Profiles', async () => {
    await setup();
    const anna = await createProfile('Anna');
    const ben = await createProfile('Ben');

    const renamed = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { name: ' Anna K. ' },
    });
    expect(renamed.status).toBe(200);
    expect(await renamed.json()).toMatchObject({ id: anna.id, name: 'Anna K.', enabled: true });

    const paused = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { enabled: false },
    });
    expect(await paused.json()).toMatchObject({ name: 'Anna K.', enabled: false });

    const activated = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { enabled: true },
    });
    expect(await activated.json()).toMatchObject({ enabled: true });

    const benAfter = await api(`/api/profiles/${ben.id}`);
    expect(await benAfter.json()).toEqual(ben);
  });

  it('rejects invalid updates and unknown Profiles', async () => {
    await setup();
    const anna = await createProfile('Anna');

    const blankName = await api(`/api/profiles/${anna.id}`, { method: 'PATCH', body: { name: '   ' } });
    expect(blankName.status).toBe(400);
    const badEnabled = await api(`/api/profiles/${anna.id}`, { method: 'PATCH', body: { enabled: 'yes' } });
    expect(badEnabled.status).toBe(400);
    const missing = await api('/api/profiles/does-not-exist', { method: 'PATCH', body: { name: 'x' } });
    expect(missing.status).toBe(404);
  });

  it('deletes a Profile and leaves other Profiles untouched', async () => {
    await setup();
    const anna = await createProfile('Anna');
    const ben = await createProfile('Ben');

    const deleted = await api(`/api/profiles/${anna.id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);

    expect((await api(`/api/profiles/${anna.id}`)).status).toBe(404);
    const list = (await (await api('/api/profiles')).json()) as ProfileJson[];
    expect(list).toEqual([ben]);

    expect((await api(`/api/profiles/${anna.id}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('waits for an in-flight sync before deleting a Profile', async () => {
    await setup();
    const anna = await createProfile('Anna');
    const appleId = 'anna@icloud.com';
    const refreshToken = 'refresh-anna';
    ctx!.providers.calendars.addAppleCalendar(appleId, { url: '/cal/home/', name: 'Home' });
    ctx!.providers.calendars.addGoogleCalendar(refreshToken, { id: 'primary', name: 'Anna', primary: true });
    ctx!.providers.calendars.putAppleEvent(
      appleId,
      '/cal/home/',
      'e1.ics',
      'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:u1\r\nDTSTART:20260501T100000Z\r\nDTEND:20260501T110000Z\r\nSUMMARY:Test\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n',
    );
    await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { appleId, appleAppPassword: 'abcd-efgh-ijkl-mnop' },
    });
    ctx!.providers.issueGoogleCode('ok', { refresh_token: refreshToken });
    const authUrlRes = await api(`/api/profiles/${anna.id}/google/auth-url`);
    const { url } = (await authUrlRes.json()) as { url: string };
    const state = new URL(url).searchParams.get('state')!;
    await api(`/api/auth/google/callback?code=ok&state=${encodeURIComponent(state)}`);
    await api(`/api/profiles/${anna.id}/rules/calendars`, {
      method: 'POST',
      body: { appleCalendarUrl: '/cal/home/', googleCalendarId: 'primary', direction: 'one_way' },
    });

    const gate = ctx!.providers.calendars.holdGoogleWrites(refreshToken);
    const order: string[] = [];
    const syncPromise = Promise.resolve(api(`/api/profiles/${anna.id}/sync`, { method: 'POST', body: {} })).then((res) => {
      order.push(`sync:${res.status}`);
      return res;
    });
    // Yield so the sync acquires the Profile lock and reaches the held Google write
    await new Promise((resolve) => setTimeout(resolve, 20));

    const deletePromise = Promise.resolve(api(`/api/profiles/${anna.id}`, { method: 'DELETE' })).then((res) => {
      order.push(`delete:${res.status}`);
      return res;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual([]);

    gate.release();
    const [syncRes, deleteRes] = await Promise.all([syncPromise, deletePromise]);
    expect(syncRes.status).toBe(200);
    expect(deleteRes.status).toBe(204);
    expect(order).toEqual(['sync:200', 'delete:204']);
  });

  it('stores the Apple app-specific password encrypted and never returns it', async () => {
    await setup();
    const anna = await createProfile('Anna');
    const ben = await createProfile('Ben');

    const res = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { appleId: ' anna@icloud.com ', appleAppPassword: 'abcd-efgh-ijkl-mnop' },
    });
    expect(res.status).toBe(200);
    const bodyText = await res.text();
    expect(JSON.parse(bodyText)).toMatchObject({
      appleId: 'anna@icloud.com',
      appleConnected: true,
    });
    expect(bodyText).not.toContain('abcd-efgh-ijkl-mnop');

    const fetched = await (await api(`/api/profiles/${anna.id}`)).text();
    const listed = await (await api('/api/profiles')).text();
    expect(fetched).not.toContain('abcd-efgh-ijkl-mnop');
    expect(listed).not.toContain('abcd-efgh-ijkl-mnop');
    expect(listed).not.toMatch(/enc/i);

    // At rest: ciphertext only, decryptable to the original with the configured key
    const row = ctx!.dbContext.sqlite
      .prepare('SELECT * FROM profiles WHERE id = ?')
      .get(anna.id) as Record<string, unknown>;
    expect(JSON.stringify(row)).not.toContain('abcd-efgh-ijkl-mnop');
    expect(decryptSecret(row.apple_app_password_enc as string, ctx!.config.encryptionKey)).toBe(
      'abcd-efgh-ijkl-mnop',
    );

    // Other Profiles stay unconnected
    expect(await (await api(`/api/profiles/${ben.id}`)).json()).toEqual(ben);
  });

  it('requires Apple ID and app-specific password together and non-empty', async () => {
    await setup();
    const anna = await createProfile('Anna');

    const onlyId = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { appleId: 'anna@icloud.com' },
    });
    expect(onlyId.status).toBe(400);
    const blankPassword = await api(`/api/profiles/${anna.id}`, {
      method: 'PATCH',
      body: { appleId: 'anna@icloud.com', appleAppPassword: '  ' },
    });
    expect(blankPassword.status).toBe(400);
    expect(await (await api(`/api/profiles/${anna.id}`)).json()).toEqual(anna);
  });

  describe('POST /api/profiles/:id/test-apple', () => {
    async function connectApple(profile: ProfileJson, appleId: string, password: string) {
      await api(`/api/profiles/${profile.id}`, {
        method: 'PATCH',
        body: { appleId, appleAppPassword: password },
      });
    }

    it('reports every protocol as passed and hands decrypted credentials only to the provider', async () => {
      await setup();
      ctx!.providers.addAppleAccount('anna@icloud.com', 'abcd-efgh-ijkl-mnop');
      const anna = await createProfile('Anna');
      await connectApple(anna, 'anna@icloud.com', 'abcd-efgh-ijkl-mnop');

      const res = await api(`/api/profiles/${anna.id}/test-apple`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: true,
        caldav: { ok: true },
        carddav: { ok: true },
        imap: { ok: true },
      });
      expect(ctx!.providers.contexts.at(-1)).toMatchObject({
        profileId: anna.id,
        apple: { appleId: 'anna@icloud.com', appPassword: 'abcd-efgh-ijkl-mnop' },
      });
    });

    it('reports partial failures per protocol with error details', async () => {
      await setup();
      ctx!.providers.addAppleAccount('anna@icloud.com', 'pw');
      ctx!.providers.failAppleProtocol('anna@icloud.com', 'imap', 'IMAP login rejected');
      const anna = await createProfile('Anna');
      await connectApple(anna, 'anna@icloud.com', 'pw');

      const res = await api(`/api/profiles/${anna.id}/test-apple`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        caldav: { ok: true },
        carddav: { ok: true },
        imap: { ok: false, error: 'IMAP login rejected' },
      });
    });

    it('fails all protocols for wrong credentials, and rejects Profiles without credentials or unknown ids', async () => {
      await setup();
      ctx!.providers.addAppleAccount('anna@icloud.com', 'right');
      const anna = await createProfile('Anna');
      const ben = await createProfile('Ben');
      await connectApple(anna, 'anna@icloud.com', 'wrong');

      const wrong = (await (await api(`/api/profiles/${anna.id}/test-apple`, { method: 'POST' })).json()) as {
        ok: boolean;
        caldav: { ok: boolean };
        carddav: { ok: boolean };
        imap: { ok: boolean };
      };
      expect(wrong).toMatchObject({
        ok: false,
        caldav: { ok: false },
        carddav: { ok: false },
        imap: { ok: false },
      });

      const unconnected = await api(`/api/profiles/${ben.id}/test-apple`, { method: 'POST' });
      expect(unconnected.status).toBe(409);
      const unknown = await api('/api/profiles/nope/test-apple', { method: 'POST' });
      expect(unknown.status).toBe(404);
    });
  });

  describe('trigger token', () => {
    async function viewToken(profile: ProfileJson): Promise<string> {
      const res = await api(`/api/profiles/${profile.id}/trigger-token`);
      expect(res.status).toBe(200);
      return ((await res.json()) as { token: string }).token;
    }

    it('gives each Profile its own stable token, stored encrypted at rest', async () => {
      await setup();
      const anna = await createProfile('Anna');
      const ben = await createProfile('Ben');

      const annaToken = await viewToken(anna);
      expect(annaToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(await viewToken(anna)).toBe(annaToken);
      expect(await viewToken(ben)).not.toBe(annaToken);

      const raw = JSON.stringify(ctx!.dbContext.sqlite.prepare('SELECT * FROM profiles').all());
      expect(raw).not.toContain(annaToken);
    });

    it('rotates the token, invalidating the old one and leaving other Profiles untouched', async () => {
      await setup();
      const anna = await createProfile('Anna');
      const ben = await createProfile('Ben');
      const oldToken = await viewToken(anna);
      const benToken = await viewToken(ben);

      const rotated = await api(`/api/profiles/${anna.id}/rotate-trigger-token`, { method: 'POST' });
      expect(rotated.status).toBe(200);
      const { token: newToken } = (await rotated.json()) as { token: string };

      expect(newToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(newToken).not.toBe(oldToken);
      expect(await viewToken(anna)).toBe(newToken);
      expect(await viewToken(ben)).toBe(benToken);

      const raw = JSON.stringify(ctx!.dbContext.sqlite.prepare('SELECT * FROM profiles').all());
      expect(raw).not.toContain(newToken);
    });

    it('returns 404 for unknown Profiles', async () => {
      await setup();
      expect((await api('/api/profiles/nope/trigger-token')).status).toBe(404);
      expect((await api('/api/profiles/nope/rotate-trigger-token', { method: 'POST' })).status).toBe(404);
    });
  });

  describe('Google OAuth linking', () => {
    const TOKENS = {
      refresh_token: 'refresh-token-secret',
      access_token: 'access-token-secret',
      expiry_date: 1_800_000_000_000,
      scope: 'calendar contacts gmail',
    };

    async function startLinking(profile: ProfileJson): Promise<{ state: string; redirectUri: string }> {
      const res = await api(`/api/profiles/${profile.id}/google/auth-url`);
      expect(res.status).toBe(200);
      const { url } = (await res.json()) as { url: string };
      const params = new URL(url).searchParams;
      return { state: params.get('state')!, redirectUri: params.get('redirect_uri')! };
    }

    function callback(params: Record<string, string>, sessionCookie: string | null = cookie) {
      const query = new URLSearchParams(params).toString();
      return api(`/api/auth/google/callback?${query}`, { cookie: sessionCookie });
    }

    async function profileState(profile: ProfileJson): Promise<ProfileJson> {
      return (await (await api(`/api/profiles/${profile.id}`)).json()) as ProfileJson;
    }

    it('derives the callback URL from the local origin, or from PUBLIC_BASE_URL when configured', async () => {
      await setup();
      const anna = await createProfile('Anna');
      expect((await startLinking(anna)).redirectUri).toBe('http://localhost/api/auth/google/callback');
      expect((await api('/api/profiles/nope/google/auth-url')).status).toBe(404);
      ctx!.close();

      ctx = createTestContext({ envOverrides: { PUBLIC_BASE_URL: 'https://sync.example.com/' } });
      cookie = await ctx.signIn();
      const ben = await createProfile('Ben');
      expect((await startLinking(ben)).redirectUri).toBe(
        'https://sync.example.com/api/auth/google/callback',
      );
    });

    it('links Google through the callback and stores the tokens encrypted', async () => {
      await setup();
      const anna = await createProfile('Anna');
      const ben = await createProfile('Ben');
      ctx!.providers.issueGoogleCode('good-code', TOKENS);
      const { state, redirectUri } = await startLinking(anna);

      const res = await callback({ code: 'good-code', state });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/?profile=${anna.id}&google=connected`);
      expect(await profileState(anna)).toMatchObject({ googleConnected: true, googleReauthRequired: false });
      expect(await profileState(ben)).toMatchObject({ googleConnected: false });

      const raw = JSON.stringify(ctx!.dbContext.sqlite.prepare('SELECT * FROM profiles').all());
      expect(raw).not.toContain('refresh-token-secret');
      expect(raw).not.toContain('access-token-secret');
      expect(redirectUri).toBe('http://localhost/api/auth/google/callback');
    });

    it('rejects callbacks with missing, forged, expired, or foreign-session state', async () => {
      await setup();
      const anna = await createProfile('Anna');
      ctx!.providers.issueGoogleCode('code-1', TOKENS);
      const { state } = await startLinking(anna);

      expect((await callback({ code: 'code-1' })).status).toBe(400);
      expect((await callback({ code: 'code-1', state: `${state.slice(0, -3)}abc` })).status).toBe(400);
      expect((await callback({ code: 'code-1', state: 'garbage' })).status).toBe(400);

      // A state minted in another admin session cannot be replayed in this one
      const otherCookie = await ctx!.signIn();
      expect((await callback({ code: 'code-1', state }, otherCookie)).status).toBe(400);

      // Unauthenticated callbacks never reach the handler
      expect((await callback({ code: 'code-1', state }, null)).status).toBe(401);

      // Expired state
      ctx!.clock.advanceMinutes(11);
      expect((await callback({ code: 'code-1', state })).status).toBe(400);

      expect(await profileState(anna)).toMatchObject({ googleConnected: false });
    });

    it('surfaces invalid_grant as a re-authentication state and clears it after a successful re-link', async () => {
      await setup();
      const anna = await createProfile('Anna');
      ctx!.providers.rejectGoogleCodeWithInvalidGrant('stale-code');
      const first = await startLinking(anna);

      const failed = await callback({ code: 'stale-code', state: first.state });

      expect(failed.status).toBe(302);
      expect(failed.headers.get('location')).toBe(`/?profile=${anna.id}&google=invalid_grant`);
      expect(await profileState(anna)).toMatchObject({
        googleConnected: false,
        googleReauthRequired: true,
      });

      ctx!.providers.issueGoogleCode('fresh-code', TOKENS);
      const second = await startLinking(anna);
      await callback({ code: 'fresh-code', state: second.state });
      expect(await profileState(anna)).toMatchObject({
        googleConnected: true,
        googleReauthRequired: false,
      });
    });

    it('accepts each OAuth state only once, even when the first attempt failed', async () => {
      await setup();
      const anna = await createProfile('Anna');
      ctx!.providers.issueGoogleCode('code-1', TOKENS);
      ctx!.providers.issueGoogleCode('code-2', { ...TOKENS, refresh_token: 'other-refresh' });
      const { state } = await startLinking(anna);

      expect((await callback({ code: 'code-1', state })).status).toBe(302);
      expect((await callback({ code: 'code-2', state })).status).toBe(400);

      ctx!.providers.rejectGoogleCodeWithInvalidGrant('stale');
      const failing = await startLinking(anna);
      expect((await callback({ code: 'stale', state: failing.state })).status).toBe(302);
      expect((await callback({ code: 'code-2', state: failing.state })).status).toBe(400);
    });

    it('keeps a path prefix from PUBLIC_BASE_URL in the callback URL', async () => {
      ctx = createTestContext({
        envOverrides: { PUBLIC_BASE_URL: 'https://example.com/cloud-sync/' },
      });
      cookie = await ctx.signIn();
      const anna = await createProfile('Anna');

      expect((await startLinking(anna)).redirectUri).toBe(
        'https://example.com/cloud-sync/api/auth/google/callback',
      );
    });

    it('redirects with an error when the user denies access', async () => {
      await setup();
      const anna = await createProfile('Anna');
      const { state } = await startLinking(anna);

      const res = await callback({ error: 'access_denied', state });

      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/?profile=${anna.id}&google=error`);
      expect(await profileState(anna)).toMatchObject({ googleConnected: false });
    });
  });
});
