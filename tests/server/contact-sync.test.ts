import { afterEach, describe, expect, it } from 'vitest';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import {
  ARBEIT_GROUP,
  FAMILIE_GROUP,
  G_ARBEIT,
  G_FAMILIE,
  appleCard,
  groupCard,
  setupContacts,
} from '../helpers/contacts-scenario.js';

const CONTACTS = ['u1', 'u2', 'u3', 'u4', 'u5', 'u6'];

describe('One-way contact sync HTTP seam', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  /** An address book with six contacts and the groups Familie (u1, u2, u3) and Arbeit (u3, u4). */
  async function setup(direction?: 'one_way' | 'bidirectional') {
    const scenario = await setupContacts();
    close = () => scenario.ctx.close();
    const { world, appleId } = scenario;
    CONTACTS.forEach((uid, i) =>
      world.putAppleVCard(appleId, `/card/${uid}.vcf`, appleCard(uid, `Vorname${i + 1}`, `Nachname${i + 1}`, [`EMAIL:${uid}@example.com`])),
    );
    const setGroups = (familie: string[], arbeit: string[]) => {
      world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', familie));
      world.putAppleVCard(appleId, '/card/arbeit.vcf', groupCard(ARBEIT_GROUP, 'Arbeit', arbeit));
    };
    setGroups(['u1', 'u2', 'u3'], ['u3', 'u4']);
    await scenario.createRule(FAMILIE_GROUP, G_FAMILIE, direction);
    await scenario.createRule(ARBEIT_GROUP, G_ARBEIT, direction);
    const byName = (given: string) => scenario.google().find((c) => c.data.givenName === given);
    return { ...scenario, setGroups, byName };
  }

  it('creates the contacts of the synced groups in Google with their label, and nothing else', async () => {
    const { sync, google, world, byName } = await setup();

    const result = await sync();

    expect(result.status).toBe('ok');
    expect(result.actions.filter((a) => a.action === 'create').map((a) => a.uid).sort()).toEqual(['u1', 'u2', 'u3', 'u4']);
    expect(google().map((c) => c.data.givenName).sort()).toEqual(['Vorname1', 'Vorname2', 'Vorname3', 'Vorname4']);
    expect(byName('Vorname1')).toMatchObject({
      data: { familyName: 'Nachname1', emails: ['u1@example.com'] },
      groupResourceNames: [G_FAMILIE],
    });
    expect(byName('Vorname4')?.groupResourceNames).toEqual([G_ARBEIT]);
    expect(world.googleWrites).toHaveLength(4);
  });

  it('keeps a contact in several synced groups once in Google, carrying all of its labels', async () => {
    const { sync, google, byName } = await setup();

    await sync();

    expect(google().filter((c) => c.data.givenName === 'Vorname3')).toHaveLength(1);
    expect([...byName('Vorname3')!.groupResourceNames].sort()).toEqual([G_FAMILIE, G_ARBEIT].sort());
  });

  it('idles while the address book is unchanged', async () => {
    const { sync, world } = await setup();
    await sync();
    const writes = world.googleWrites.length;

    const again = await sync();

    expect(again).toMatchObject({ status: 'skipped', reason: 'unchanged', actions: [] });
    expect(world.googleWrites).toHaveLength(writes);
  });

  it('removes only the label when a contact leaves a synced group but stays in the address book', async () => {
    const { sync, google, setGroups, byName, world } = await setup();
    await sync();
    const writes = world.googleWrites.length;

    setGroups(['u1', 'u2'], ['u3', 'u4']); // u3 leaves Familie, stays in Arbeit
    const result = await sync();

    expect([...byName('Vorname3')!.groupResourceNames]).toEqual([G_ARBEIT]);
    expect(google()).toHaveLength(4);
    expect(result.actions).toContainEqual(expect.objectContaining({ action: 'update', uid: 'u3', reason: 'labels_changed' }));
    expect(world.googleWrites.slice(writes).map((w) => w.kind)).toEqual(['update']);
  });

  it('stops tracking a contact that left every synced group, leaving it untouched in Google', async () => {
    const { sync, google, setGroups, world, appleId } = await setup();
    await sync();

    setGroups(['u1', 'u2', 'u3'], ['u3']); // u4 leaves Arbeit and is in no synced group anymore
    await sync();
    expect(google().find((c) => c.data.givenName === 'Vorname4')?.groupResourceNames).toEqual([]);

    // Deleting it in Apple later is no concern of the sync anymore
    world.removeAppleVCard(appleId, '/card/u4.vcf');
    await sync();
    expect(google().map((c) => c.data.givenName)).toContain('Vorname4');
  });

  it('deletes the Google contact when the contact is actually deleted in Apple', async () => {
    const { sync, google, world, appleId } = await setup();
    await sync();
    // Enough tracked contacts around it keep one deletion under the Delete Guard threshold
    ['u5', 'u6'].forEach((uid) => world.putAppleVCard(appleId, `/card/${uid}.vcf`, appleCard(uid, uid, 'X')));
    world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', ['u1', 'u2', 'u3', 'u5', 'u6']));
    await sync();

    world.removeAppleVCard(appleId, '/card/u2.vcf');
    const result = await sync();

    expect(result.actions).toContainEqual(expect.objectContaining({ action: 'delete', uid: 'u2' }));
    expect(google().map((c) => c.data.givenName)).not.toContain('Vorname2');
    expect(google()).toHaveLength(5);
  });

  describe('Initial Sync matching', () => {
    it('links pre-existing Google contacts by email, phone or name, and leaves unmatched ones untouched', async () => {
      const { sync, google, world, appleId, token } = await setup();
      world.putAppleVCard(appleId, '/card/u2.vcf', appleCard('u2', 'Vorname2', 'Nachname2', ['TEL:+49 30 555 0100']));
      const byEmail = world.seedGoogleContact(token, { givenName: 'Alias', emails: ['U1@Example.com'] });
      const byPhone = world.seedGoogleContact(token, { givenName: 'Telefon', phones: ['030 555 0100'.replace('030', '+49 30')] });
      const byName = world.seedGoogleContact(token, { givenName: 'Vorname3', familyName: 'Nachname3' });
      const stranger = world.seedGoogleContact(token, { givenName: 'Fremder', emails: ['fremd@example.com'] });

      const result = await sync();

      expect(result.actions.filter((a) => a.reason === 'matched_existing').map((a) => a.uid)).toEqual(['u1', 'u2', 'u3']);
      expect(result.actions.filter((a) => a.action === 'create').map((a) => a.uid)).toEqual(['u4']);
      expect(google()).toHaveLength(5); // 4 pre-existing + u4; nothing duplicated
      // Linked contacts keep their own data and just receive the labels
      expect(google().find((c) => c.resourceName === byEmail.resourceName)).toMatchObject({
        data: { givenName: 'Alias' },
        groupResourceNames: [G_FAMILIE],
      });
      expect([...google().find((c) => c.resourceName === byName.resourceName)!.groupResourceNames].sort()).toEqual(
        [G_FAMILIE, G_ARBEIT].sort(),
      );
      expect(google().find((c) => c.resourceName === byPhone.resourceName)?.groupResourceNames).toEqual([G_FAMILIE]);
      // One-Way Sync never touches or imports what only exists in Google
      expect(google().find((c) => c.resourceName === stranger.resourceName)).toEqual(stranger);
      expect(world.appleHrefs(appleId).filter((h) => h.includes('Fremder'))).toEqual([]);

      // Linked contacts are tracked: an Apple edit updates them in place
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Max', 'Neu', ['EMAIL:u1@example.com']));
      await sync();
      expect(google().find((c) => c.resourceName === byEmail.resourceName)?.data).toMatchObject({ givenName: 'Max', familyName: 'Neu' });
      expect(google()).toHaveLength(5);
    });
  });

  describe('One-Way drift immunity', () => {
    it('ignores edits and deletions made in Google until Apple changes the contact again', async () => {
      const { sync, google, world, appleId, token, byName } = await setup();
      await sync();
      const u1 = byName('Vorname1')!;
      const u2 = byName('Vorname2')!;
      world.editGoogleContact(token, u1.resourceName, { givenName: 'Manuell' });
      world.removeGoogleContact(token, u2.resourceName);

      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'unchanged' });
      expect(google().find((c) => c.resourceName === u1.resourceName)?.data.givenName).toBe('Manuell');
      expect(google().map((c) => c.resourceName)).not.toContain(u2.resourceName);

      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Apple', 'Nachname1', ['EMAIL:u1@example.com']));
      world.putAppleVCard(appleId, '/card/u2.vcf', appleCard('u2', 'Zwei', 'Nachname2', ['EMAIL:u2@example.com']));
      await sync();

      expect(google().find((c) => c.resourceName === u1.resourceName)?.data.givenName).toBe('Apple');
      // The manually deleted contact is recreated, carrying its label again
      expect(google().find((c) => c.data.givenName === 'Zwei')?.groupResourceNames).toEqual([G_FAMILIE]);
    });
  });

  describe('Photos', () => {
    const photo = (bytes: number[]) => `PHOTO;ENCODING=b;TYPE=JPEG:${Buffer.from(bytes).toString('base64')}`;

    it('uploads a photo only when its hash changed', async () => {
      const { sync, world, appleId, token, byName } = await setup();
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Vorname1', 'Nachname1', [photo([1, 2, 3])]));

      await sync();
      expect(world.photoUploads.map((u) => [...u.photo])).toEqual([[1, 2, 3]]);
      expect(world.googlePhoto(token, byName('Vorname1')!.resourceName)).toEqual(Buffer.from([1, 2, 3]));

      // The contact changes but the photo does not: no upload
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Anders', 'Nachname1', [photo([1, 2, 3])]));
      await sync();
      expect(world.photoUploads).toHaveLength(1);

      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Anders', 'Nachname1', [photo([9, 9])]));
      await sync();
      expect(world.photoUploads.map((u) => [...u.photo])).toEqual([[1, 2, 3], [9, 9]]);
    });
  });

  describe('Dry-Run', () => {
    it('previews exactly what the real run does, without writing anything', async () => {
      const { sync, dryRun, world, ctx, google } = await setup();
      const stateBefore = () =>
        JSON.stringify([
          ctx.dbContext.sqlite.prepare('SELECT * FROM synced_contacts').all(),
          ctx.dbContext.sqlite.prepare('SELECT * FROM contact_sync_state').all(),
          ctx.dbContext.sqlite.prepare('SELECT * FROM contact_sync_rules').all(),
        ]);
      const before = stateBefore();

      const preview = await dryRun();

      expect(preview.status).toBe('ok');
      expect(preview.actions.filter((a) => a.action === 'create')).toHaveLength(4);
      expect(world.googleWrites).toEqual([]);
      expect(google()).toEqual([]);
      expect(stateBefore()).toBe(before);

      expect((await sync()).actions).toEqual(preview.actions);
    });
  });

  describe('Paused rules', () => {
    it('freezes contacts that only belong to a paused rule', async () => {
      const { sync, google, world, appleId, api, rulesPath, byName } = await setup();
      await sync();
      const rules = await api.json<Array<{ id: string; appleGroupName: string }>>(rulesPath);
      const arbeit = rules.find((r) => r.appleGroupName === 'Arbeit')!;
      await api.request(`${rulesPath}/${arbeit.id}`, { method: 'PATCH', body: { enabled: false } });

      world.removeAppleVCard(appleId, '/card/u4.vcf');
      const result = await sync();

      expect(result.actions.some((a) => a.action === 'delete')).toBe(false);
      expect(byName('Vorname4')).toBeDefined();
      // A contact that is also in an active group keeps the paused group's label
      expect([...byName('Vorname3')!.groupResourceNames].sort()).toEqual([G_FAMILIE, G_ARBEIT].sort());
      expect(google()).toHaveLength(4);
    });

    it('does nothing when every rule is paused', async () => {
      const { sync, api, rulesPath, world } = await setup();
      for (const rule of await api.json<Array<{ id: string }>>(rulesPath)) {
        await api.request(`${rulesPath}/${rule.id}`, { method: 'PATCH', body: { enabled: false } });
      }

      expect(await sync()).toMatchObject({ status: 'skipped', reason: 'paused' });
      expect(world.googleWrites).toEqual([]);
    });
  });

  describe('Deleting a rule', () => {
    it('keeps the synced Google contacts and their labels by default', async () => {
      const { sync, google, api, rulesPath, world, appleId, byName } = await setup();
      await sync();
      const arbeit = (await api.json<Array<{ id: string; appleGroupName: string }>>(rulesPath)).find((r) => r.appleGroupName === 'Arbeit')!;
      const writes = world.googleWrites.length;

      expect((await api.request(`${rulesPath}/${arbeit.id}`, { method: 'DELETE' })).status).toBe(204);
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Vorname1', 'Nachname1', ['EMAIL:u1@example.com', 'NOTE:x']));
      await sync();

      expect(world.googleWrites.slice(writes).every((w) => w.kind === 'update')).toBe(true);
      expect(google()).toHaveLength(4);
      expect(byName('Vorname4')?.groupResourceNames).toEqual([G_ARBEIT]);
      expect([...byName('Vorname3')!.groupResourceNames].sort()).toEqual([G_FAMILIE, G_ARBEIT].sort());
    });

    it('with the cleanup opt-in removes the rule label, and contacts no other rule keeps', async () => {
      const { sync, google, api, rulesPath, byName } = await setup();
      await sync();
      const familie = (await api.json<Array<{ id: string; appleGroupName: string }>>(rulesPath)).find((r) => r.appleGroupName === 'Familie')!;

      const res = await api.request(`${rulesPath}/${familie.id}?cleanupGoogle=true`, { method: 'DELETE' });

      expect(res.status).toBe(204);
      // u1 and u2 only belonged to Familie; u3 is in Arbeit as well and stays, minus the Familie label
      expect(google().map((c) => c.data.givenName).sort()).toEqual(['Vorname3', 'Vorname4']);
      expect(byName('Vorname3')?.groupResourceNames).toEqual([G_ARBEIT]);
    });
  });

  describe('Delete Guard', () => {
    async function halted() {
      const ctx = await setup();
      await ctx.sync();
      ['u1', 'u2', 'u3'].forEach((uid) => ctx.world.removeAppleVCard(ctx.appleId, `/card/${uid}.vcf`));
      const result = await ctx.sync();
      const [approval] = await ctx.pending();
      return { ...ctx, result, approval };
    }

    it('halts a mass deletion, queues the batch and applies nothing of it', async () => {
      const { result, approval, google } = await halted();

      expect(result.deleteApprovalId).toBe(approval.id);
      expect(result.actions.filter((a) => a.reason === 'delete_guard')).toHaveLength(3);
      expect(google()).toHaveLength(4);
      expect(approval).toMatchObject({ domain: 'contacts', ruleId: null, status: 'pending' });
      expect(approval.items.map((i) => [i.uid, i.target])).toEqual([['u1', 'google'], ['u2', 'google'], ['u3', 'google']]);
    });

    it('approve deletes exactly the approved batch and marks it approved', async () => {
      const { api, approval, google } = await halted();

      const res = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ status: 'approved', domain: 'contacts' });
      expect(google().map((c) => c.data.givenName)).toEqual(['Vorname4']);
    });

    it('dismiss leaves everything in place', async () => {
      const { api, approval, google, pending } = await halted();

      const res = await api.request(`/api/delete-approvals/${approval.id}/dismiss`, { method: 'POST' });

      expect(((await res.json()) as DeleteApprovalDto).status).toBe('dismissed');
      expect(google()).toHaveLength(4);
      expect(await pending()).toEqual([]);
    });
  });
});
