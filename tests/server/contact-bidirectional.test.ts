import { afterEach, describe, expect, it } from 'vitest';
import { parseVCard } from '../../src/server/sync/vcard.js';
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

describe('Bidirectional contact sync (Apple Master) HTTP seam', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  /** Six contacts; Familie (bidirectional) holds u1-u5, Arbeit (one-way) holds u6. */
  async function setup() {
    const scenario = await setupContacts();
    close = () => scenario.ctx.close();
    const { world, appleId } = scenario;
    CONTACTS.forEach((uid, i) =>
      world.putAppleVCard(
        appleId,
        `/card/${uid}.vcf`,
        appleCard(uid, `Vorname${i + 1}`, `Nachname${i + 1}`, [
          `EMAIL:${uid}@example.com`,
          'X-ABADR:de',
          'item1.TEL:+49 30 555 0100',
          'item1.X-ABLabel:Büro',
        ]),
      ),
    );
    world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', ['u1', 'u2', 'u3', 'u4', 'u5']));
    world.putAppleVCard(appleId, '/card/arbeit.vcf', groupCard(ARBEIT_GROUP, 'Arbeit', ['u6']));
    await scenario.createRule(FAMILIE_GROUP, G_FAMILIE, 'bidirectional');
    await scenario.createRule(ARBEIT_GROUP, G_ARBEIT, 'one_way');
    await scenario.sync();
    const byName = (given: string) => scenario.google().find((c) => c.data.givenName === given)!;
    return { ...scenario, byName };
  }

  it('merges a Google edit into the current Apple vCard, keeping everything Apple-specific', async () => {
    const { sync, world, appleId, token, byName } = await setup();
    const googleWrites = world.googleWrites.length;
    world.editGoogleContact(token, byName('Vorname1').resourceName, {
      ...byName('Vorname1').data,
      givenName: 'Maximilian',
      note: 'Aus Google',
    });

    const result = await sync();

    expect(result.actions).toContainEqual({
      action: 'update',
      uid: 'u1',
      summary: 'Maximilian Nachname1',
      direction: 'google_to_apple',
    });
    const card = world.appleVCard(appleId, '/card/u1.vcf')!;
    expect(parseVCard(card).data).toMatchObject({ givenName: 'Maximilian', note: 'Aus Google', emails: ['u1@example.com'] });
    for (const kept of ['X-ABADR:de', 'item1.TEL:+49 30 555 0100', 'item1.X-ABLabel:Büro', 'PRODID:-//Apple Inc.//iOS 18.2//EN']) {
      expect(card).toContain(kept);
    }
    expect(world.googleWrites).toHaveLength(googleWrites);

    // Our own write is no new change on either side
    const writes = world.appleWrites.length;
    const again = await sync();
    expect(again.actions.every((a) => a.action === 'skip')).toBe(true);
    expect(world.appleWrites).toHaveLength(writes);
    expect(world.googleWrites).toHaveLength(googleWrites);
  });

  it('never writes Google edits of contacts that only belong to a one-way rule back to Apple', async () => {
    const { sync, world, appleId, token, byName } = await setup();
    const before = world.appleVCard(appleId, '/card/u6.vcf');
    world.editGoogleContact(token, byName('Vorname6').resourceName, { givenName: 'Eigenmächtig' });

    await sync();

    expect(world.appleVCard(appleId, '/card/u6.vcf')).toBe(before);
  });

  it('lets Apple overwrite Google when both sides edited the same contact', async () => {
    const { sync, world, appleId, token, byName } = await setup();
    const u2 = byName('Vorname2');
    world.editGoogleContact(token, u2.resourceName, { givenName: 'Google-Version' });
    world.putAppleVCard(appleId, '/card/u2.vcf', appleCard('u2', 'Apple-Version', 'Nachname2', ['EMAIL:u2@example.com']));
    const appleWrites = world.appleWrites.length;

    const result = await sync();

    expect(result.actions).toContainEqual(expect.objectContaining({ action: 'update', uid: 'u2', reason: 'apple_master' }));
    expect(world.googleContact(token, u2.resourceName)?.data.givenName).toBe('Apple-Version');
    expect(world.appleWrites).toHaveLength(appleWrites);

    const again = await sync();
    expect(again.actions.every((a) => a.action === 'skip')).toBe(true);
  });

  it('carries on and lets Apple win when Apple changes a contact while a Google edit is written back', async () => {
    const { sync, world, appleId, token, byName } = await setup();
    const [u1, u2] = [byName('Vorname1'), byName('Vorname2')];
    world.editGoogleContact(token, u1.resourceName, { givenName: 'Google-1' });
    world.editGoogleContact(token, u2.resourceName, { givenName: 'Google-2' });
    world.changeAppleBeforeNextOverwrite(() =>
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Apple-1', 'Nachname1', ['EMAIL:u1@example.com'])),
    );

    const result = await sync();

    expect(result.status).toBe('ok');
    expect(parseVCard(world.appleVCard(appleId, '/card/u2.vcf')!).data.givenName).toBe('Google-2');
    await sync();
    expect(world.googleContact(token, u1.resourceName)?.data.givenName).toBe('Apple-1');
  });

  describe('Google-only contacts', () => {
    it('imports a contact carrying the rule label into Apple and into the Apple group, losslessly', async () => {
      const { sync, world, appleId, token } = await setup();
      const created = world.seedGoogleContact(token, { givenName: 'Neu', familyName: 'InGoogle', emails: ['neu@example.com'] }, [G_FAMILIE]);
      const unlabeled = world.seedGoogleContact(token, { givenName: 'Ohne', familyName: 'Label' });
      const groupBefore = world.appleVCard(appleId, '/card/familie.vcf')!;
      const googleWrites = world.googleWrites.length;

      const result = await sync();

      const imported = result.actions.find((a) => a.action === 'create')!;
      expect(imported).toMatchObject({ summary: 'Neu InGoogle', direction: 'google_to_apple' });
      const card = world.appleVCard(appleId, `/card/${imported.uid}.vcf`)!;
      expect(parseVCard(card).data).toMatchObject({ givenName: 'Neu', familyName: 'InGoogle', emails: ['neu@example.com'] });
      // The Apple group lists the new contact; its other lines are untouched
      const group = world.appleVCard(appleId, '/card/familie.vcf')!;
      expect(parseVCard(group).memberUids).toEqual([...parseVCard(groupBefore).memberUids, imported.uid]);
      expect(group.replace(`X-ADDRESSBOOKSERVER-MEMBER:urn:uuid:${imported.uid}\r\n`, '')).toBe(groupBefore);
      // A Google contact without a managed label is left alone
      expect(world.appleHrefs(appleId).some((h) => h.includes('Label'))).toBe(false);
      expect(world.googleContact(token, unlabeled.resourceName)).toEqual(unlabeled);
      expect(world.googleWrites).toHaveLength(googleWrites);

      // Tracked and in scope from now on: nothing is imported twice, no label is stripped
      await sync();
      expect(world.appleHrefs(appleId).filter((h) => h.endsWith(`${imported.uid}.vcf`))).toHaveLength(1);
      expect(world.googleContact(token, created.resourceName)?.groupResourceNames).toEqual([G_FAMILIE]);
    });

    it('does not import a Google contact whose Apple twin exists outside the rule group', async () => {
      const { sync, world, appleId, token } = await setup();
      world.putAppleVCard(appleId, '/card/extern.vcf', appleCard('extern', 'Erika', 'Extern', ['EMAIL:erika@example.com']));
      world.seedGoogleContact(token, { givenName: 'Erika', familyName: 'Extern', emails: ['ERIKA@example.com'] }, [G_FAMILIE]);
      const cardsBefore = world.appleHrefs(appleId).length;

      const result = await sync();

      expect(result.actions.some((a) => a.action === 'create')).toBe(false);
      expect(world.appleHrefs(appleId)).toHaveLength(cardsBefore);
    });

    it('imports unmatched Google contacts and links matched ones on the Initial Sync', async () => {
      const scenario = await setupContacts();
      close = () => scenario.ctx.close();
      const { world, appleId, token } = scenario;
      world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Max', 'Muster', ['EMAIL:max@example.com']));
      world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', ['u1']));
      world.seedGoogleContact(token, { givenName: 'Maximilian', emails: ['MAX@example.com'] });
      world.seedGoogleContact(token, { givenName: 'Nur', familyName: 'Google', emails: ['nur@example.com'] }, [G_FAMILIE]);
      world.seedGoogleContact(token, { givenName: 'Fremd', emails: ['fremd@example.com'] });
      await scenario.createRule(FAMILIE_GROUP, G_FAMILIE, 'bidirectional');

      const result = await scenario.sync();

      expect(result.actions.map((a) => [a.action, a.summary, a.reason])).toEqual([
        ['skip', 'Max Muster', 'matched_existing'],
        ['create', 'Nur Google', undefined],
      ]);
      expect(scenario.google()).toHaveLength(3); // nothing duplicated or deleted
      expect(world.appleHrefs(appleId).filter((h) => h.startsWith('/card/') && !h.includes('familie'))).toHaveLength(2);
    });
  });

  describe('Google deletions', () => {
    it('deletes in Apple what was deleted in Google, and the deletion is final', async () => {
      const { sync, world, appleId, token, byName, google } = await setup();
      world.removeGoogleContact(token, byName('Vorname3').resourceName);

      const result = await sync();

      expect(result.actions).toContainEqual({ action: 'delete', uid: 'u3', summary: 'Vorname3 Nachname3', direction: 'google_to_apple' });
      expect(world.appleVCard(appleId, '/card/u3.vcf')).toBeUndefined();
      await sync();
      expect(google()).toHaveLength(5);
    });

    it('halts a mass deletion made in Google before it reaches Apple, and executes it on approval', async () => {
      const { sync, world, appleId, token, byName, pending, api } = await setup();
      ['Vorname1', 'Vorname2', 'Vorname3'].forEach((n) => world.removeGoogleContact(token, byName(n).resourceName));

      const result = await sync();

      expect(result.actions.filter((a) => a.reason === 'delete_guard')).toHaveLength(3);
      expect(['u1', 'u2', 'u3'].every((uid) => world.appleVCard(appleId, `/card/${uid}.vcf`))).toBe(true);
      const [approval] = await pending();
      expect(approval.items.map((i) => i.target)).toEqual(['apple', 'apple', 'apple']);

      const res = await api.request(`/api/delete-approvals/${approval.id}/approve`, { method: 'POST' });

      expect(res.status).toBe(200);
      expect(['u1', 'u2', 'u3'].some((uid) => world.appleVCard(appleId, `/card/${uid}.vcf`))).toBe(false);
      expect(world.appleVCard(appleId, '/card/u4.vcf')).toBeDefined();
    });
  });

  describe('Google sync token', () => {
    it('recovers from an expired token with a full re-reconciliation, neither duplicating nor falsely deleting', async () => {
      const { sync, world, appleId, token, byName, google } = await setup();
      world.editGoogleContact(token, byName('Vorname2').resourceName, { givenName: 'Zwei-Google' });
      world.removeGoogleContact(token, byName('Vorname5').resourceName);
      world.expireGoogleSyncTokens(token);
      const googleWrites = world.googleWrites.length;
      world.trace.length = 0;

      const result = await sync();

      expect(result.status).toBe('ok');
      const reads = world.trace.filter((t) => t.startsWith('google.contact-changes'));
      expect(reads).toHaveLength(2);
      expect(reads[1]).toMatch(/:full$/);
      expect(parseVCard(world.appleVCard(appleId, '/card/u2.vcf')!).data.givenName).toBe('Zwei-Google');
      expect(world.appleVCard(appleId, '/card/u5.vcf')).toBeUndefined();
      for (const uid of ['u1', 'u3', 'u4', 'u6']) {
        expect(world.appleVCard(appleId, `/card/${uid}.vcf`)).toBeDefined();
      }
      expect(google()).toHaveLength(5);
      expect(world.googleWrites).toHaveLength(googleWrites);
    });
  });
});
