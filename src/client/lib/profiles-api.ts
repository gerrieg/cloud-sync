export interface Profile {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly appleId: string | null;
  readonly appleConnected: boolean;
  readonly googleConnected: boolean;
  readonly googleReauthRequired: boolean;
  readonly lastSyncAt: number | null;
  readonly lastSyncStatus: string | null;
}

export type ProfilePatch = Partial<{
  name: string;
  enabled: boolean;
  appleId: string;
  appleAppPassword: string;
}>;

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(path, {
    method: init?.method ?? 'GET',
    credentials: 'same-origin',
    headers: init?.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (response.status === 204) {
    return undefined as T;
  }

  const data = (await response.json().catch(() => ({}))) as { error?: unknown };
  if (!response.ok) {
    throw new Error(
      typeof data.error === 'string' && data.error ? data.error : `Request failed (${response.status})`,
    );
  }
  return data as T;
}

export function listProfiles(): Promise<Profile[]> {
  return request('/api/profiles');
}

export function createProfile(name: string): Promise<Profile> {
  return request('/api/profiles', { method: 'POST', body: { name } });
}

export function updateProfile(id: string, patch: ProfilePatch): Promise<Profile> {
  return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function deleteProfile(id: string): Promise<void> {
  return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export type ProtocolResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

export interface AppleTestReport {
  readonly ok: boolean;
  readonly caldav: ProtocolResult;
  readonly carddav: ProtocolResult;
  readonly imap: ProtocolResult;
}

export function testAppleConnection(id: string): Promise<AppleTestReport> {
  return request(`/api/profiles/${encodeURIComponent(id)}/test-apple`, { method: 'POST' });
}

export async function getGoogleAuthUrl(id: string): Promise<string> {
  const data = await request<{ url: string }>(`/api/profiles/${encodeURIComponent(id)}/google/auth-url`);
  return data.url;
}

export async function getTriggerToken(id: string): Promise<string> {
  const data = await request<{ token: string }>(`/api/profiles/${encodeURIComponent(id)}/trigger-token`);
  return data.token;
}

export async function rotateTriggerToken(id: string): Promise<string> {
  const data = await request<{ token: string }>(
    `/api/profiles/${encodeURIComponent(id)}/rotate-trigger-token`,
    { method: 'POST' },
  );
  return data.token;
}
