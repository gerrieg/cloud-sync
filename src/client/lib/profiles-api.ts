import type { AppleTestReport, ProfileDto, ProfileStatusDto, ProfileUpdate } from '../../shared/profile.js';
import { apiRequest as request } from './http.js';

export type { AppleTestReport, ProfileDto as Profile, ProfileStatusDto, ProfileUpdate };

export function listProfiles(): Promise<ProfileDto[]> {
  return request('/api/profiles');
}

export function createProfile(name: string): Promise<ProfileDto> {
  return request('/api/profiles', { method: 'POST', body: { name } });
}

export function updateProfile(id: string, patch: ProfileUpdate): Promise<ProfileDto> {
  return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'PATCH', body: patch });
}

export function deleteProfile(id: string): Promise<void> {
  return request(`/api/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' });
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

export function getProfileStatus(id: string): Promise<ProfileStatusDto> {
  return request(`/api/profiles/${encodeURIComponent(id)}/status`);
}
