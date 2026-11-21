import type { ContactRuleDto, ContactRunResult } from '../../src/shared/contacts.js';
import type { SyncRunResult } from '../../src/shared/calendar.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from './api.js';
import { createTestContext } from './test-app.js';

export const FAMILIE_GROUP = '7B0C9E11-9999-4B1E-9A11-FFFFFFFFFFFF';
export const ARBEIT_GROUP = '7B0C9E11-8888-4B1E-9A11-EEEEEEEEEEEE';
export const G_FAMILIE = 'contactGroups/fam';
export const G_ARBEIT = 'contactGroups/work';

/** A minimal Apple vCard 3.0 contact. */
export function appleCard(uid: string, given: string, family: string, extra: string[] = []): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iOS 18.2//EN',
    `N:${family};${given};;;`,
    `FN:${given} ${family}`,
    ...extra,
    `UID:${uid}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

/** An Apple contact group card with the given member UIDs. */
export function groupCard(uid: string, name: string, members: string[]): string {
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'PRODID:-//Apple Inc.//iOS 18.2//EN',
    `N:${name};;;;`,
    `FN:${name}`,
    'X-ADDRESSBOOKSERVER-KIND:group',
    ...members.map((m) => `X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${m}`),
    `UID:${uid}`,
    'END:VCARD',
    '',
  ].join('\r\n');
}

/** A connected Profile with an empty Apple address book and a Google account that has two labels. */
export async function setupContacts() {
  const ctx = createTestContext();
  const api = new TestApi(ctx, await ctx.signIn());
  const world = ctx.providers.contacts;
  world.addGoogleAccount(GOOGLE_REFRESH_TOKEN, [
    { resourceName: G_FAMILIE, name: 'Familie' },
    { resourceName: G_ARBEIT, name: 'Arbeit' },
  ]);
  const profile = await api.createProfile('Anna');
  await api.connectAccounts(profile);

  const rulesPath = `/api/profiles/${profile.id}/rules/contacts`;
  const createRule = async (apple: string, google: string, direction?: 'one_way' | 'bidirectional') => {
    const res = await api.request(rulesPath, {
      method: 'POST',
      body: { appleGroupUid: apple, googleGroupResourceName: google, ...(direction ? { direction } : {}) },
    });
    return (await res.json()) as ContactRuleDto;
  };

  const run = async (path: 'sync' | 'dry-run', body: unknown = { domain: 'contacts' }) =>
    (await (await api.request(`/api/profiles/${profile.id}/${path}`, { method: 'POST', body })).json()) as SyncRunResult;
  return {
    api,
    ctx,
    world,
    profile: profile as ProfileDto,
    rulesPath,
    createRule,
    sync: async (body?: unknown): Promise<ContactRunResult> => (await run('sync', body)).contacts!,
    dryRun: async (body?: unknown): Promise<ContactRunResult> => (await run('dry-run', body)).contacts!,
    pending: () => api.json<DeleteApprovalDto[]>(`/api/profiles/${profile.id}/delete-approvals`),
    google: () => world.googleContacts(GOOGLE_REFRESH_TOKEN),
    appleId: APPLE_ID,
    token: GOOGLE_REFRESH_TOKEN,
  };
}
