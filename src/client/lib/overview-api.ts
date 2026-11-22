import type { ProfileOverviewDto, SyncAllResult } from '../../shared/profile.js';
import { apiRequest as request } from './http.js';

export type { ProfileOverviewDto, SyncAllResult };

export function getOverview(): Promise<ProfileOverviewDto[]> {
  return request('/api/overview');
}

export function syncAll(): Promise<SyncAllResult> {
  return request('/api/sync-all', { method: 'POST' });
}
