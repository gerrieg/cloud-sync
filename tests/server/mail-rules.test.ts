import { afterEach, describe, expect, it } from 'vitest';
import type { MailFolderDiscovery, MailRuleDto } from '../../src/shared/mail.js';
import { setupMail } from '../helpers/mail-scenario.js';

describe('Mail folder discovery and Mail Folder Sync Rules HTTP seam', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function setup() {
    const scenario = await setupMail();
    close = () => scenario.ctx.close();
    return scenario;
  }

  it('discovers the selectable iCloud folders with their Gmail label, leaving out Drafts, Junk and Trash', async () => {
    const { api, profile, world, appleId } = await setup();
    world.addAppleFolder(appleId, 'Projects/2026');
    world.addAppleFolder(appleId, 'Projects', null, false);

    const res = await api.request(`/api/profiles/${profile.id}/discover/mail-folders`);

    expect(res.status).toBe(200);
    expect((await res.json()) as MailFolderDiscovery).toEqual({
      folders: [
        { path: 'INBOX', name: 'INBOX', googleLabel: 'INBOX' },
        { path: 'Sent Messages', name: 'Sent Messages', googleLabel: 'SENT' },
        { path: 'Receipts', name: 'Receipts', googleLabel: 'Receipts' },
        { path: 'Archive', name: 'Archive', googleLabel: 'Archive' },
        { path: 'Projects/2026', name: 'Projects/2026', googleLabel: 'Projects/2026' },
      ],
    });
  });

  it('requires both accounts to be connected', async () => {
    const { api } = await setup();
    const unconnected = await api.createProfile('Ben');

    expect((await api.request(`/api/profiles/${unconnected.id}/discover/mail-folders`)).status).toBe(409);
  });

  it('creates a rule that is active, trashes deletions and syncs the last 30 days by default', async () => {
    const { api, rulesPath } = await setup();

    const res = await api.request(rulesPath, { method: 'POST', body: { appleFolderPath: 'Sent Messages' } });

    expect(res.status).toBe(201);
    expect((await res.json()) as MailRuleDto).toMatchObject({
      appleFolderPath: 'Sent Messages',
      googleLabel: 'SENT',
      syncWindowDays: 30,
      deleteBehavior: 'trash',
      enabled: true,
    });
    expect((await api.json<MailRuleDto[]>(rulesPath)).map((r) => r.appleFolderPath)).toEqual(['Sent Messages']);
  });

  it('accepts a custom window, all history and the delete behavior, and updates them later', async () => {
    const { api, rulesPath, createRule } = await setup();
    const rule = await createRule('Receipts', { syncWindowDays: null, deleteBehavior: 'delete', enabled: false });
    expect(rule).toMatchObject({ syncWindowDays: null, deleteBehavior: 'delete', enabled: false });

    const patched = await api.request(`${rulesPath}/${rule.id}`, {
      method: 'PATCH',
      body: { syncWindowDays: 90, deleteBehavior: 'trash', enabled: true },
    });

    expect(patched.status).toBe(200);
    expect((await patched.json()) as MailRuleDto).toMatchObject({ syncWindowDays: 90, deleteBehavior: 'trash', enabled: true });
  });

  it('rejects invalid input, unknown folders, excluded folders and duplicates', async () => {
    const { api, rulesPath, createRule } = await setup();
    const post = (body: Record<string, unknown>) => api.request(rulesPath, { method: 'POST', body });

    expect((await post({})).status).toBe(400);
    expect((await post({ appleFolderPath: 'INBOX', syncWindowDays: 0 })).status).toBe(400);
    expect((await post({ appleFolderPath: 'INBOX', deleteBehavior: 'shred' })).status).toBe(400);
    expect((await post({ appleFolderPath: 'INBOX', enabled: 'yes' })).status).toBe(400);
    expect((await post({ appleFolderPath: 'Nope' })).status).toBe(400);
    expect((await post({ appleFolderPath: 'Drafts' })).status).toBe(400);
    expect((await post({ appleFolderPath: 'Junk' })).status).toBe(400);
    expect((await post({ appleFolderPath: 'Deleted Messages' })).status).toBe(400);

    await createRule('INBOX');
    expect((await post({ appleFolderPath: 'INBOX' })).status).toBe(409);
    expect((await api.request(`${rulesPath}/missing`, { method: 'PATCH', body: {} })).status).toBe(404);
  });

  describe('deleting a rule', () => {
    it('keeps the synced Gmail messages by default and with cleanupGoogle=false', async () => {
      const { api, rulesPath, createRule, deliver, sync, gmail } = await setup();
      const rule = await createRule('INBOX');
      deliver('INBOX', 'Hello');
      await sync();

      const res = await api.request(`${rulesPath}/${rule.id}`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      expect(await api.json<MailRuleDto[]>(rulesPath)).toEqual([]);
      expect(gmail()).toHaveLength(1);
    });

    it('with cleanupGoogle=true removes what only this rule synced and only unlabels the rest', async () => {
      const { api, rulesPath, createRule, deliver, sync, gmail, world, appleId } = await setup();
      const inbox = await createRule('INBOX');
      await createRule('Receipts');
      deliver('INBOX', 'Only inbox');
      const shared = deliver('INBOX', 'Shared');
      world.copy(appleId, 'INBOX', shared, 'Receipts');
      await sync();

      const res = await api.request(`${rulesPath}/${inbox.id}?cleanupGoogle=true`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      const remaining = gmail();
      expect(remaining.filter((m) => !m.labels.includes('TRASH')).map((m) => [m.raw.includes('Shared'), m.labels])).toEqual([
        [true, ['Receipts', 'UNREAD']],
      ]);
      expect(remaining.find((m) => m.raw.includes('Only inbox'))?.labels).toContain('TRASH');
    });

    it('with cleanupGoogle=true permanently deletes when the rule says delete', async () => {
      const { api, rulesPath, createRule, deliver, sync, gmail } = await setup();
      const rule = await createRule('INBOX', { deleteBehavior: 'delete' });
      deliver('INBOX', 'Hello');
      await sync();

      await api.request(`${rulesPath}/${rule.id}?cleanupGoogle=true`, { method: 'DELETE' });

      expect(gmail()).toEqual([]);
    });

    it('rejects a malformed cleanupGoogle value and unknown rules', async () => {
      const { api, rulesPath, createRule } = await setup();
      const rule = await createRule('INBOX');

      expect((await api.request(`${rulesPath}/${rule.id}?cleanupGoogle=maybe`, { method: 'DELETE' })).status).toBe(400);
      expect((await api.request(`${rulesPath}/missing`, { method: 'DELETE' })).status).toBe(404);
    });
  });
});
