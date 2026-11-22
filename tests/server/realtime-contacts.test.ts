import { afterEach, describe, expect, it } from 'vitest';
import { appleCard, setupContacts, G_FAMILIE } from '../helpers/contacts-scenario.js';

describe('real-time contact sync', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  it('picks up Apple and Google contact changes by polling within a few minutes', async () => {
    const s = await setupContacts();
    close = () => s.ctx.close();
    await s.createRule('all', G_FAMILIE, 'bidirectional');
    const tick = async (advanceMs: number) => {
      s.ctx.clock.advanceMs(advanceMs);
      await s.ctx.realtime.tick();
      await s.ctx.realtime.settled();
    };
    await tick(0);

    s.world.putAppleVCard(s.appleId, 'anna.vcf', appleCard('uid-anna', 'Anna', 'Muster'));
    await tick(60_000);
    expect(s.google()).toEqual([]);

    await tick(60_000);
    const [synced] = s.google();
    expect(synced?.data).toMatchObject({ givenName: 'Anna', familyName: 'Muster' });

    s.world.editGoogleContact(s.token, synced!.resourceName, { givenName: 'Annika' });
    await tick(120_000);
    expect(s.world.appleVCard(s.appleId, 'anna.vcf')).toContain('Annika');
  });

  it.each(['one_way', 'bidirectional'] as const)(
    'syncs a %s rule that is created again after it was deleted together with its Google contacts',
    async (direction) => {
      const s = await setupContacts();
      close = () => s.ctx.close();
      const tick = async (advanceMs: number) => {
        s.ctx.clock.advanceMs(advanceMs);
        await s.ctx.realtime.tick();
        await s.ctx.realtime.settled();
      };
      s.world.putAppleVCard(s.appleId, 'anna.vcf', appleCard('uid-anna', 'Anna', 'Muster'));
      const rule = await s.createRule('all', G_FAMILIE, direction);
      await tick(0);
      await tick(120_000);
      expect(s.google().map((c) => c.data.givenName)).toEqual(['Anna']);

      await s.api.request(`${s.rulesPath}/${rule.id}?cleanupGoogle=true`, { method: 'DELETE' });
      expect(s.google()).toEqual([]);
      await tick(120_000);
      await s.createRule('all', G_FAMILIE, direction);
      await tick(120_000);

      expect(s.google().map((c) => c.data.givenName)).toEqual(['Anna']);
    },
  );

  it('does not poll contacts for a Profile without contact rules', async () => {
    const s = await setupContacts();
    close = () => s.ctx.close();
    s.world.putAppleVCard(s.appleId, 'anna.vcf', appleCard('uid-anna', 'Anna', 'Muster'));

    await s.ctx.realtime.tick();
    s.ctx.clock.advanceMs(300_000);
    await s.ctx.realtime.tick();
    await s.ctx.realtime.settled();

    expect(s.google()).toEqual([]);
  });
});
