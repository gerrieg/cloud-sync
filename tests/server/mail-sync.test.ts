import { afterEach, describe, expect, it } from 'vitest';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import { DAY_MS, rawMail, setupMail } from '../helpers/mail-scenario.js';

describe('One-way mail sync (iCloud IMAP → Gmail) HTTP seam', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function setup() {
    const scenario = await setupMail();
    close = () => scenario.ctx.close();
    const subjects = (messages = scenario.gmail()) => messages.map((m) => /Subject: (.*)\r/.exec(m.raw)![1]).sort();
    const byRaw = (subject: string) => scenario.gmail().find((m) => m.raw.includes(`Subject: ${subject}\r`))!;
    return { ...scenario, subjects, byRaw };
  }

  const changes = (result: { actions: readonly { action: string }[] }) => result.actions.filter((a) => a.action !== 'skip');

  /** Six filler messages keep a single deletion below the Delete Guard threshold. */
  async function setupWithFiller(options: Record<string, unknown> = {}) {
    const scenario = await setup();
    await scenario.createRule('INBOX', options);
    await scenario.createRule('Receipts', options);
    for (let i = 1; i <= 6; i += 1) {
      scenario.deliver('INBOX', `Filler ${i}`, { seen: true });
    }
    return scenario;
  }

  describe('importing', () => {
    it('imports the raw RFC 822 message with its folder label and its initial flags', async () => {
      const { createRule, deliver, sync, gmail, world } = await setup();
      for (const folder of ['INBOX', 'Sent Messages', 'Receipts', 'Archive']) {
        await createRule(folder);
      }
      deliver('INBOX', 'Unread mail');
      deliver('INBOX', 'Read and starred', { seen: true, flagged: true });
      deliver('Sent Messages', 'My reply', { seen: true });
      deliver('Receipts', 'Invoice', { seen: true });
      deliver('Archive', 'Old stuff', { seen: true });

      const result = await sync();

      expect(result.status).toBe('ok');
      expect(result.actions.map((a) => a.action)).toEqual(['create', 'create', 'create', 'create', 'create']);
      const labelsOf = (subject: string) => gmail().find((m) => m.raw.includes(`Subject: ${subject}\r`))?.labels;
      expect(labelsOf('Unread mail')).toEqual(['INBOX', 'UNREAD']);
      expect(labelsOf('Read and starred')).toEqual(['INBOX', 'STARRED']);
      expect(labelsOf('My reply')).toEqual(['SENT']);
      expect(labelsOf('Invoice')).toEqual(['Receipts']);
      expect(labelsOf('Old stuff')).toEqual(['Archive']);
      // A missing custom label is created; an existing one is reused
      expect(world.googleWrites.filter((w) => w.kind === 'createLabel')).toHaveLength(1);
    });

    it('imports the message byte for byte as iCloud holds it', async () => {
      const { createRule, sync, gmail, world, appleId, ctx } = await setup();
      await createRule('Receipts');
      const raw = rawMail({ subject: 'Invoice', body: 'Ünïcode body\r\n\r\nwith blank lines' });
      world.deliver(appleId, 'Receipts', { raw, seen: true, internalDate: ctx.clock.now() - DAY_MS });

      await sync();

      expect(gmail().map((m) => m.raw)).toEqual([raw]);
    });

    it('only imports messages inside the start-date window, and everything when the window is all history', async () => {
      const { createRule, deliver, sync, subjects, api, rulesPath } = await setup();
      const rule = await createRule('INBOX');
      deliver('INBOX', 'Recent', { daysAgo: 5 });
      deliver('INBOX', 'Edge', { daysAgo: 29 });
      deliver('INBOX', 'Ancient', { daysAgo: 400 });

      await sync();
      expect(subjects()).toEqual(['Edge', 'Recent']);

      await api.request(`${rulesPath}/${rule.id}`, { method: 'PATCH', body: { syncWindowDays: null } });
      await sync();
      expect(subjects()).toEqual(['Ancient', 'Edge', 'Recent']);
    });

    it('is idle when nothing changed and never reads known messages again', async () => {
      const { createRule, deliver, sync, world } = await setup();
      await createRule('INBOX');
      deliver('INBOX', 'One');
      deliver('INBOX', 'Two');
      await sync();
      const writes = world.googleWrites.length;
      const reads = world.envelopeFetches.length;

      const again = await sync();

      expect(again.actions.every((a) => a.action === 'skip')).toBe(true);
      expect(world.googleWrites).toHaveLength(writes);
      expect(world.envelopeFetches).toHaveLength(reads);
    });

    it('does not import anything for a paused rule, and picks the folder up once it is active', async () => {
      const { createRule, deliver, sync, gmail, api, rulesPath } = await setup();
      const rule = await createRule('INBOX', { enabled: false });
      deliver('INBOX', 'Waiting');

      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'paused', actions: [] });
      expect(gmail()).toEqual([]);

      await api.request(`${rulesPath}/${rule.id}`, { method: 'PATCH', body: { enabled: true } });
      await sync();
      expect(gmail()).toHaveLength(1);
    });

    it('reports a folder that disappeared from iCloud instead of failing the run', async () => {
      const { createRule, sync, world, appleId } = await setup();
      await createRule('Archive');
      world.removeAppleFolder(appleId, 'Archive');

      expect(await sync()).toMatchObject({ status: 'error', error: expect.stringContaining('Archive') });
    });
  });

  describe('failures and quota', () => {
    it('imports the other messages even when Gmail rejects one, and reports the error', async () => {
      const { createRule, deliver, sync, subjects, world } = await setup();
      await createRule('INBOX');
      deliver('INBOX', 'Fine one');
      deliver('INBOX', 'Poison');
      deliver('INBOX', 'Fine two');
      world.rejectImportsContaining('Subject: Poison');

      const result = await sync();

      expect(result).toMatchObject({ status: 'error', error: 'Gmail rejected the message' });
      expect(subjects()).toEqual(['Fine one', 'Fine two']);
    });

    it('survives a message with an unusable Date header', async () => {
      const { createRule, sync, gmail, world, appleId, ctx } = await setup();
      await createRule('INBOX');
      world.deliver(appleId, 'INBOX', {
        raw: rawMail({ subject: 'Odd date', date: 'not a date at all' }),
        internalDate: ctx.clock.now() - DAY_MS,
      });

      expect((await sync()).status).toBe('ok');
      expect(gmail()).toHaveLength(1);
    });

    it('backfills a large folder in batches instead of one endless run', async () => {
      const { createRule, deliver, sync, gmail } = await setup();
      await createRule('INBOX');
      for (let i = 1; i <= 120; i += 1) {
        deliver('INBOX', `Backlog ${i}`, { seen: true });
      }

      const first = await sync();
      expect(first.actions.filter((a) => a.action === 'create')).toHaveLength(100);
      expect(gmail()).toHaveLength(100);

      await sync();
      expect(gmail()).toHaveLength(120);
    });

    it('reuses an existing Gmail label whose name differs only in case', async () => {
      const { createRule, deliver, sync, world, token } = await setup();
      world.addGoogleAccount(token, ['receipts']); // Gmail label names are case-insensitive
      await createRule('Receipts');
      deliver('Receipts', 'Invoice', { seen: true });

      expect((await sync()).status).toBe('ok');
      expect(world.googleWrites.filter((w) => w.kind === 'createLabel')).toEqual([]);
    });
  });

  describe('profile-wide deduplication', () => {
    it('keeps a message that sits in several synced folders once in Gmail, with all of its labels', async () => {
      const { createRule, deliver, sync, gmail, world, appleId } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      const uid = deliver('INBOX', 'Twice', { seen: true, messageId: '<Same@Example.com>' });
      world.copy(appleId, 'INBOX', uid, 'Receipts');

      await sync();

      expect(gmail().map((m) => m.labels)).toEqual([['INBOX', 'Receipts']]);
      expect(world.googleWrites.filter((w) => w.kind === 'import')).toHaveLength(1);
    });

    it('normalizes the Message-ID, so differently written copies are the same message', async () => {
      const { createRule, deliver, sync, gmail } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      deliver('INBOX', 'Copy A', { messageId: '<ABC@Example.com>' });
      deliver('Receipts', 'Copy B', { messageId: ' abc@example.com ' });

      await sync();

      expect(gmail()).toHaveLength(1);
    });

    it('falls back to a hash of Date, From, Subject and Size when the Message-ID is missing', async () => {
      const { createRule, sync, gmail, world, appleId } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      const raw = rawMail({ subject: 'No id', messageId: null });
      const uid = world.deliver(appleId, 'INBOX', { raw, internalDate: Date.UTC(2026, 0, 14) });
      world.copy(appleId, 'INBOX', uid, 'Receipts');
      world.deliver(appleId, 'INBOX', { raw: rawMail({ subject: 'No id either', messageId: null }), internalDate: Date.UTC(2026, 0, 14) });
      world.deliver(appleId, 'INBOX', { raw: rawMail({ subject: 'No id', messageId: null, body: 'a different body' }), internalDate: Date.UTC(2026, 0, 14) });

      await sync();

      // The copy is deduplicated, the different subject and the different size are distinct messages
      expect(gmail()).toHaveLength(3);
      expect(gmail().find((m) => m.labels.includes('Receipts'))?.labels).toEqual(['INBOX', 'Receipts', 'UNREAD']);
    });
  });

  describe('moving between synced folders', () => {
    it('swaps the labels in place instead of importing the message again', async () => {
      const { createRule, deliver, sync, gmail, world, appleId } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      const uid = deliver('INBOX', 'Moving', { seen: true });
      await sync();
      const before = gmail()[0]!;
      const imports = world.googleWrites.filter((w) => w.kind === 'import').length;

      world.move(appleId, 'INBOX', uid, 'Receipts');
      const result = await sync();

      expect(result.actions).toEqual([expect.objectContaining({ action: 'update', reason: 'moved' })]);
      expect(gmail()).toEqual([{ ...before, labels: ['Receipts'] }]);
      expect(world.googleWrites.filter((w) => w.kind === 'import')).toHaveLength(imports);
      expect(world.googleWrites.filter((w) => w.kind === 'trash')).toEqual([]);
    });

    it('does not mistake an old tracked message moved between synced folders for a deletion', async () => {
      const { createRule, deliver, sync, gmail, world, appleId, ctx } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      const uid = deliver('INBOX', 'Aging', { seen: true, daysAgo: 29 });
      await sync();

      ctx.clock.advanceDays(10); // it is now outside the window
      world.move(appleId, 'INBOX', uid, 'Receipts');
      const result = await sync();

      expect(result.actions).toEqual([expect.objectContaining({ action: 'update', reason: 'moved' })]);
      expect(gmail().map((m) => m.labels)).toEqual([['Receipts']]);
    });

    it('removes only the label of a folder a copy was deleted from while another copy remains', async () => {
      const { createRule, deliver, sync, gmail, world, appleId } = await setup();
      await createRule('INBOX');
      await createRule('Receipts');
      const uid = deliver('INBOX', 'Two homes', { seen: true });
      world.copy(appleId, 'INBOX', uid, 'Receipts');
      await sync();

      world.expunge(appleId, 'INBOX', uid);
      await sync();

      expect(gmail().map((m) => m.labels)).toEqual([['Receipts']]);
    });
  });

  describe('UIDVALIDITY changes', () => {
    it('re-indexes the folder by message key without any Gmail trash, delete or import', async () => {
      const { deliver, sync, gmail, world, appleId } = await setupWithFiller();
      deliver('INBOX', 'Survivor', { seen: true });
      await sync();
      const writes = world.googleWrites.length;

      world.resetUidValidity(appleId, 'INBOX');
      const result = await sync();

      expect(result.status).toBe('ok');
      expect(result.actions.every((a) => a.action === 'skip')).toBe(true);
      expect(world.googleWrites).toHaveLength(writes);
      expect(gmail()).toHaveLength(7);

      // The new UIDs are tracked: a later deletion of the message is still noticed
      world.expunge(appleId, 'INBOX', world.appleUids(appleId, 'INBOX')[0]!);
      const later = await sync();
      expect(later.actions.filter((a) => a.action === 'delete')).toHaveLength(1);
    });

    it('does not take messages missing right after a renumbering for deleted ones', async () => {
      const { deliver, sync, world, appleId } = await setupWithFiller();
      deliver('INBOX', 'Vanishes', { seen: true });
      await sync();
      const writes = world.googleWrites.length;

      world.resetUidValidity(appleId, 'INBOX');
      // A message is deleted at the very moment the folder is renumbered
      world.expunge(appleId, 'INBOX', world.appleUids(appleId, 'INBOX')[0]!);
      const result = await sync();

      expect(result.actions.some((a) => a.action === 'delete')).toBe(false);
      expect(result.actions).toContainEqual(expect.objectContaining({ action: 'skip', reason: 'uidvalidity_changed' }));
      expect(world.googleWrites).toHaveLength(writes);
    });
  });

  describe('UIDVALIDITY changes, continued', () => {
    it('never confuses a message that is gone with another one that was given its old UID', async () => {
      const { deliver, sync, gmail, world, appleId } = await setupWithFiller();
      await sync();
      const fifth = world.appleUids(appleId, 'INBOX')[4]!;

      // Renumbered so that the new UIDs overlap the old ones: the new UID of 'Filler 2' is the old
      // UID of 'Filler 5', which is deleted right at the renumbering
      const mapping = world.resetUidValidity(appleId, 'INBOX', 1);
      world.expunge(appleId, 'INBOX', mapping.get(fifth)!);
      deliver('INBOX', 'Newcomer', { seen: true });
      await sync();
      const result = await sync();

      expect(result.actions.filter((a) => a.action === 'delete').map((a) => a.summary)).toEqual(['Filler 5']);
      expect(gmail()).toHaveLength(7);
    });
  });

  describe('deletions', () => {
    it('trashes the Gmail message when it is moved to Deleted Messages, then leaves it alone', async () => {
      const { deliver, sync, byRaw, world, appleId } = await setupWithFiller();
      const uid = deliver('INBOX', 'Unwanted', { seen: true });
      await sync();

      world.move(appleId, 'INBOX', uid, 'Deleted Messages');
      const result = await sync();

      expect(changes(result)).toEqual([expect.objectContaining({ action: 'update', reason: 'moved_to_trash' })]);
      expect(byRaw('Unwanted').labels).toContain('TRASH');
      const writes = world.googleWrites.length;
      await sync();
      expect(world.googleWrites).toHaveLength(writes);
    });

    it('emptying the iCloud trash leaves the Gmail trash alone', async () => {
      const { deliver, sync, byRaw, world, appleId } = await setupWithFiller();
      const uid = deliver('INBOX', 'Unwanted', { seen: true });
      await sync();
      const trashed = world.move(appleId, 'INBOX', uid, 'Deleted Messages');
      await sync();
      const writes = world.googleWrites.length;

      world.expunge(appleId, 'Deleted Messages', trashed);
      await sync();

      expect(world.googleWrites).toHaveLength(writes);
      expect(byRaw('Unwanted').labels).toContain('TRASH');
    });

    it('moves a message that is expunged directly to the Gmail trash, never deleting it permanently', async () => {
      const { deliver, sync, byRaw, gmail, world, appleId } = await setupWithFiller();
      const uid = deliver('INBOX', 'Expunged', { seen: true });
      await sync();

      world.expunge(appleId, 'INBOX', uid);
      await sync();

      expect(gmail()).toHaveLength(7);
      expect(byRaw('Expunged').labels).toContain('TRASH');
      expect(world.googleWrites.at(-1)?.kind).toBe('trash');
    });

    it('brings a message back to Gmail when it is moved out of Deleted Messages again', async () => {
      const { deliver, sync, byRaw, world, appleId } = await setupWithFiller();
      const uid = deliver('INBOX', 'Regretted', { seen: true });
      await sync();
      const trashed = world.move(appleId, 'INBOX', uid, 'Deleted Messages');
      await sync();
      expect(byRaw('Regretted').labels).toContain('TRASH');

      world.move(appleId, 'Deleted Messages', trashed, 'INBOX');
      const result = await sync();

      expect(changes(result)).toEqual([expect.objectContaining({ action: 'update', reason: 'restored_from_trash' })]);
      expect(byRaw('Regretted').labels).toEqual(['INBOX']);
      // It is an ordinary message again: deleting it later is noticed
      world.expunge(appleId, 'INBOX', world.appleUids(appleId, 'INBOX').at(-1)!);
      expect(changes(await sync())).toEqual([expect.objectContaining({ action: 'delete', summary: 'Regretted' })]);
    });

    it('does not mind a Gmail message that was already deleted by hand', async () => {
      const { deliver, sync, byRaw, world, appleId, token } = await setupWithFiller();
      const uid = deliver('INBOX', 'Twice gone', { seen: true });
      await sync();
      world.removeGmailMessage(token, byRaw('Twice gone').id);

      world.expunge(appleId, 'INBOX', uid);

      expect((await sync()).status).toBe('ok');
    });
  });

  describe('Delete Guard', () => {
    async function spike() {
      const scenario = await setupWithFiller();
      const { world, appleId, deliver } = scenario;
      for (let i = 1; i <= 3; i += 1) {
        deliver('Receipts', `Receipt ${i}`, { seen: true });
      }
      await scenario.sync();
      for (const uid of world.appleUids(appleId, 'INBOX').slice(0, 4)) {
        world.expunge(appleId, 'INBOX', uid);
      }
      return scenario;
    }

    it('halts a deletion spike, queues it for approval and touches nothing in Gmail', async () => {
      const { sync, pending, gmail, world } = await spike();
      const writes = world.googleWrites.length;

      const result = await sync();

      expect(result.deleteApprovalId).toBeDefined();
      expect(result.actions.filter((a) => a.reason === 'delete_guard')).toHaveLength(4);
      expect(world.googleWrites).toHaveLength(writes);
      expect(gmail()).toHaveLength(9);
      expect(await pending()).toEqual([
        expect.objectContaining({ id: result.deleteApprovalId, domain: 'mail', label: 'Mail', items: expect.any(Array) }),
      ]);
    });

    it('carries out exactly the halted batch on approval', async () => {
      const { sync, pending, gmail, api } = await spike();
      const { deleteApprovalId } = await sync();

      const res = await api.request(`/api/delete-approvals/${deleteApprovalId}/approve`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'approved', domain: 'mail', label: 'Mail' });
      expect(gmail().filter((m) => m.labels.includes('TRASH'))).toHaveLength(4);
      expect(await pending()).toEqual([]);
    });

    it('keeps everything on dismissal, and does not repeat the same batch while it is pending', async () => {
      const { sync, pending, gmail, api } = await spike();
      const first = await sync();
      const second = await sync();
      expect(second.deleteApprovalId).toBe(first.deleteApprovalId);
      expect(await pending()).toHaveLength(1);

      const res = await api.request(`/api/delete-approvals/${first.deleteApprovalId}/dismiss`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(gmail().filter((m) => m.labels.includes('TRASH'))).toEqual([]);
      expect((await pending()) as DeleteApprovalDto[]).toEqual([]);
    });

    it('never holds back a message that was moved to Deleted Messages, even during a spike', async () => {
      const { sync, byRaw, world, appleId } = await spike();
      world.move(appleId, 'Receipts', world.appleUids(appleId, 'Receipts')[0]!, 'Deleted Messages');

      const result = await sync();

      expect(result.deleteApprovalId).toBeDefined();
      expect(result.actions).toContainEqual(expect.objectContaining({ action: 'update', reason: 'moved_to_trash' }));
      expect(byRaw('Receipt 1').labels).toContain('TRASH');
    });
  });

  describe('flags', () => {
    it('propagates \\Seen and \\Flagged changes as UNREAD and STARRED, in both directions', async () => {
      const { createRule, deliver, sync, byRaw, world, appleId } = await setup();
      await createRule('INBOX');
      const uid = deliver('INBOX', 'News');
      await sync();
      expect(byRaw('News').labels).toEqual(['INBOX', 'UNREAD']);

      world.setFlags(appleId, 'INBOX', uid, { seen: true });
      const read = await sync();
      expect(read.actions).toEqual([expect.objectContaining({ action: 'update', reason: 'flags_changed' })]);
      expect(byRaw('News').labels).toEqual(['INBOX']);

      world.setFlags(appleId, 'INBOX', uid, { flagged: true });
      await sync();
      expect(byRaw('News').labels).toEqual(['INBOX', 'STARRED']);

      world.setFlags(appleId, 'INBOX', uid, { seen: false, flagged: false });
      await sync();
      expect(byRaw('News').labels).toEqual(['INBOX', 'UNREAD']);
    });
  });

  describe('One-Way Sync drift immunity', () => {
    async function synced() {
      const scenario = await setup();
      await scenario.createRule('INBOX');
      const uid = scenario.deliver('INBOX', 'Mine', { seen: true });
      await scenario.sync();
      const message = scenario.byRaw('Mine');
      return { ...scenario, uid, message };
    }

    it('ignores manual edits and deletions in Gmail while iCloud stays as it is', async () => {
      const { sync, world, token, message, gmail } = await synced();
      world.editGmail(token, message.id, { add: ['UNREAD', 'STARRED'], remove: ['INBOX'] });
      const writes = world.googleWrites.length;

      await sync();
      expect(gmail()[0]!.labels).toEqual(['STARRED', 'UNREAD']);

      world.removeGmailMessage(token, message.id);
      await sync();
      expect(gmail()).toEqual([]);
      expect(world.googleWrites).toHaveLength(writes);
    });

    it('applies an iCloud change on top of the drift without undoing the rest of it', async () => {
      const { sync, world, token, message, gmail, uid, appleId } = await synced();
      world.editGmail(token, message.id, { remove: ['INBOX'] });

      world.setFlags(appleId, 'INBOX', uid, { flagged: true });
      await sync();

      expect(gmail()[0]!.labels).toEqual(['STARRED']);
    });

    it('starts a message afresh when iCloud changes it after it was deleted by hand in Gmail', async () => {
      const { sync, world, token, message, gmail, uid, appleId } = await synced();
      world.removeGmailMessage(token, message.id);

      world.setFlags(appleId, 'INBOX', uid, { flagged: true });
      await sync();

      expect(gmail().map((m) => [m.raw.includes('Subject: Mine'), m.labels])).toEqual([[true, ['INBOX', 'STARRED']]]);
    });

    it('undoes the drift on Force-Resync', async () => {
      const { sync, world, token, message, gmail } = await synced();
      world.editGmail(token, message.id, { add: ['UNREAD', 'STARRED'], remove: ['INBOX'] });

      const result = await sync({ domain: 'mail', force: true });

      expect(result.actions).toEqual([expect.objectContaining({ action: 'update', reason: 'force_resync' })]);
      expect(gmail()[0]!.labels).toEqual(['INBOX']);
    });
  });

  describe('paused rules', () => {
    it('leave their folder and the messages synced from it untouched', async () => {
      const { createRule, deliver, sync, gmail, world, appleId, api, rulesPath } = await setup();
      await createRule('INBOX');
      const receipts = await createRule('Receipts');
      const uid = deliver('Receipts', 'Held', { seen: true });
      await sync();

      await api.request(`${rulesPath}/${receipts.id}`, { method: 'PATCH', body: { enabled: false } });
      world.expunge(appleId, 'Receipts', uid);
      deliver('Receipts', 'New while paused');
      const writes = world.googleWrites.length;
      await sync();

      expect(world.googleWrites).toHaveLength(writes);
      expect(gmail()).toHaveLength(1);
    });
  });

  describe('Dry-Run', () => {
    it('plans the import without writing anything, not even a Gmail label', async () => {
      const { createRule, deliver, dryRun, sync, gmail, world } = await setup();
      await createRule('Archive');
      deliver('Archive', 'Preview me');

      const preview = await dryRun();

      expect(preview.actions).toEqual([expect.objectContaining({ action: 'create', summary: 'Preview me' })]);
      expect(world.googleWrites).toEqual([]);
      expect(world.rawFetches).toEqual([]);
      expect(gmail()).toEqual([]);

      // Nothing was recorded either: a real run still imports it
      expect((await sync()).actions).toEqual([expect.objectContaining({ action: 'create' })]);
      expect(gmail()).toHaveLength(1);
    });

    it('plans moves and deletions of tracked messages without carrying them out', async () => {
      const { deliver, dryRun, sync, gmail, world, appleId } = await setupWithFiller();
      const moved = deliver('INBOX', 'Moved', { seen: true });
      const gone = deliver('INBOX', 'Gone', { seen: true });
      await sync();
      world.move(appleId, 'INBOX', moved, 'Receipts');
      world.expunge(appleId, 'INBOX', gone);
      const before = gmail();
      const writes = world.googleWrites.length;

      const preview = await dryRun();

      expect(preview.actions.filter((a) => a.action !== 'skip').map((a) => [a.action, a.reason])).toEqual([
        ['update', 'moved'],
        ['delete', 'expunged'],
      ]);
      expect(world.googleWrites).toHaveLength(writes);
      expect(gmail()).toEqual(before);
    });
  });
});
