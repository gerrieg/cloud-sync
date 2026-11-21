import type { SyncRunResult } from '../../src/shared/calendar.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import type { MailRuleDto, MailRunResult } from '../../src/shared/mail.js';
import type { ProfileDto } from '../../src/shared/profile.js';
import { APPLE_ID, GOOGLE_REFRESH_TOKEN, TestApi } from './api.js';
import { createTestContext } from './test-app.js';

export const DAY_MS = 86_400_000;

/** A minimal RFC 822 message. `messageId: null` leaves the header out. */
export function rawMail(options: {
  subject: string;
  messageId?: string | null;
  from?: string;
  date?: string;
  body?: string;
}): string {
  const messageId = options.messageId === undefined ? `<${options.subject.replace(/\W+/g, '-')}@example.com>` : options.messageId;
  return [
    ...(messageId ? [`Message-ID: ${messageId}`] : []),
    `From: ${options.from ?? 'Anna <anna@example.com>'}`,
    'To: me@example.com',
    `Subject: ${options.subject}`,
    `Date: ${options.date ?? 'Wed, 14 Jan 2026 09:00:00 +0000'}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    options.body ?? `Body of ${options.subject}`,
    '',
  ].join('\r\n');
}

/**
 * A connected Profile whose iCloud has INBOX, Sent Messages, Receipts, Drafts, Junk and Deleted
 * Messages, and whose Gmail already has a `Receipts` label. The fake clock starts 2026-01-15 12:00.
 */
export async function setupMail() {
  const ctx = createTestContext();
  const api = new TestApi(ctx, await ctx.signIn());
  const world = ctx.providers.mail;
  world.addGoogleAccount(GOOGLE_REFRESH_TOKEN, ['Receipts']);
  world.addAppleFolder(APPLE_ID, 'INBOX', 'inbox');
  world.addAppleFolder(APPLE_ID, 'Sent Messages', 'sent');
  world.addAppleFolder(APPLE_ID, 'Receipts');
  world.addAppleFolder(APPLE_ID, 'Archive');
  world.addAppleFolder(APPLE_ID, 'Drafts', 'drafts');
  world.addAppleFolder(APPLE_ID, 'Junk', 'junk');
  world.addAppleFolder(APPLE_ID, 'Deleted Messages', 'trash');
  const profile = await api.createProfile('Anna');
  await api.connectAccounts(profile);

  const rulesPath = `/api/profiles/${profile.id}/rules/mail`;
  const createRule = async (folder: string, options: Record<string, unknown> = {}) => {
    const res = await api.request(rulesPath, { method: 'POST', body: { appleFolderPath: folder, ...options } });
    return (await res.json()) as MailRuleDto;
  };
  const run = async (path: 'sync' | 'dry-run', body: unknown = { domain: 'mail' }) =>
    (await (await api.request(`/api/profiles/${profile.id}/${path}`, { method: 'POST', body })).json()) as SyncRunResult;
  const now = () => ctx.clock.now();

  return {
    api,
    ctx,
    world,
    profile: profile as ProfileDto,
    rulesPath,
    createRule,
    sync: async (body?: unknown): Promise<MailRunResult> => (await run('sync', body)).mail!,
    dryRun: async (body?: unknown): Promise<MailRunResult> => (await run('dry-run', body)).mail!,
    pending: () => api.json<DeleteApprovalDto[]>(`/api/profiles/${profile.id}/delete-approvals`),
    gmail: () => world.gmailMessages(GOOGLE_REFRESH_TOKEN),
    appleId: APPLE_ID,
    token: GOOGLE_REFRESH_TOKEN,
    /** Delivers a message dated `daysAgo` days before the fake clock. */
    deliver: (folder: string, subject: string, options: { daysAgo?: number; seen?: boolean; flagged?: boolean; messageId?: string | null } = {}) => {
      const internalDate = now() - (options.daysAgo ?? 1) * DAY_MS;
      return world.deliver(APPLE_ID, folder, {
        raw: rawMail({ subject, messageId: options.messageId, date: new Date(internalDate).toUTCString() }),
        seen: options.seen,
        flagged: options.flagged,
        internalDate,
      });
    },
  };
}
