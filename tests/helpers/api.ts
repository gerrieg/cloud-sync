import type { ProfileDto } from '../../src/shared/profile.js';
import type { TestContext } from './test-app.js';

export const APPLE_ID = 'anna@icloud.com';
export const GOOGLE_REFRESH_TOKEN = 'anna-refresh-token';

/** Thin authenticated client for the Hono app under test. */
export class TestApi {
  private codeCounter = 0;

  constructor(
    readonly ctx: TestContext,
    private readonly cookie: string,
  ) {}

  request(path: string, init?: { method?: string; body?: unknown; cookie?: string | null }) {
    const headers: Record<string, string> = {};
    const cookie = init?.cookie === undefined ? this.cookie : init.cookie;
    if (cookie) {
      headers.cookie = cookie;
    }
    if (init?.body !== undefined) {
      headers['content-type'] = 'application/json';
    }
    return this.ctx.app.request(path, {
      method: init?.method ?? 'GET',
      headers,
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  async json<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  async createProfile(name: string): Promise<ProfileDto> {
    const res = await this.request('/api/profiles', { method: 'POST', body: { name } });
    return (await res.json()) as ProfileDto;
  }

  /** Stores Apple credentials and links Google through the real OAuth callback. */
  async connectAccounts(
    profile: ProfileDto,
    accounts: { appleId?: string; googleRefreshToken?: string } = {},
  ): Promise<void> {
    const appleId = accounts.appleId ?? APPLE_ID;
    const refreshToken = accounts.googleRefreshToken ?? GOOGLE_REFRESH_TOKEN;

    await this.request(`/api/profiles/${profile.id}`, {
      method: 'PATCH',
      body: { appleId, appleAppPassword: 'app-password' },
    });

    const code = `code-${(this.codeCounter += 1)}`;
    this.ctx.providers.issueGoogleCode(code, { refresh_token: refreshToken });
    const { url } = await this.json<{ url: string }>(`/api/profiles/${profile.id}/google/auth-url`);
    const state = new URL(url).searchParams.get('state')!;
    await this.request(`/api/auth/google/callback?code=${code}&state=${encodeURIComponent(state)}`);
  }
}
