import { afterEach, describe, expect, it } from 'vitest';
import type { ProfileDto, ProfileStatusDto } from '../../src/shared/profile.js';
import { setupMail } from '../helpers/mail-scenario.js';

describe('real-time mail sync', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function scenario(rules: string[] = ['INBOX']) {
    const s = await setupMail();
    close = () => s.ctx.close();
    for (const folder of rules) {
      await s.createRule(folder);
    }
    const tick = async (advanceMs = 0) => {
      s.ctx.clock.advanceMs(advanceMs);
      await s.ctx.realtime.tick();
      await s.ctx.realtime.settled();
    };
    const status = () => s.api.json<ProfileStatusDto>(`/api/profiles/${s.profile.id}/status`);
    const lastSyncAt = async () =>
      (await s.api.json<ProfileDto>(`/api/profiles/${s.profile.id}`)).lastSyncAt;
    return { ...s, tick, status, lastSyncAt, idle: () => s.world.openIdleConnections(s.appleId) };
  }

  describe('INBOX IMAP IDLE', () => {
    it('keeps one IDLE connection and syncs INBOX the moment a message arrives', async () => {
      const s = await scenario();
      await s.tick();
      expect(s.idle()).toBe(1);
      expect(s.gmail()).toEqual([]);

      s.deliver('INBOX', 'Fresh');
      await s.ctx.realtime.settled();

      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Fresh')]);
    });

    it('reconnects after a drop with exponential backoff and catches up on what it missed', async () => {
      const s = await scenario();
      await s.tick();
      s.world.dropIdleConnections(s.appleId);
      expect(s.idle()).toBe(0);
      s.deliver('INBOX', 'While offline');

      // Backoff 1s: too early, nothing happens
      await s.tick(500);
      expect(s.idle()).toBe(0);
      expect(s.gmail()).toEqual([]);

      await s.tick(500);
      expect(s.idle()).toBe(1);
      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: While offline')]);
    });

    it('does not report a connection that dropped before it was stored, and reconnects', async () => {
      const s = await scenario();
      s.world.dropNextIdleRightAfterOpen(s.appleId);

      await s.tick();
      expect(await s.status()).toMatchObject({ mailIdle: 'reconnecting' });

      await s.tick(1000);
      expect(s.idle()).toBe(1);
      expect(await s.status()).toMatchObject({ mailIdle: 'connected' });
    });

    it('doubles the wait after every failed attempt', async () => {
      const s = await scenario();
      s.world.failIdleConnects(s.appleId, 2);

      await s.tick();
      expect(s.world.idleConnectAttempts(s.appleId)).toBe(1);
      await s.tick(1000);
      expect(s.world.idleConnectAttempts(s.appleId)).toBe(2);
      await s.tick(1000);
      expect(s.world.idleConnectAttempts(s.appleId)).toBe(2);
      await s.tick(1000);
      expect(s.world.idleConnectAttempts(s.appleId)).toBe(3);
      expect(s.idle()).toBe(1);
    });

    it('never opens more than one connection, however many mail folders are synced and however often it drops', async () => {
      const s = await scenario(['INBOX', 'Receipts', 'Archive']);
      await s.tick();
      for (let i = 0; i < 3; i += 1) {
        s.world.dropIdleConnections(s.appleId);
        await s.tick(60_000);
        await s.tick(60_000);
      }

      expect(s.world.peakIdleConnections(s.appleId)).toBe(1);
      expect(s.idle()).toBe(1);
    });

    it('closes the connection when the Profile is paused and reopens it when activated', async () => {
      const s = await scenario();
      await s.tick();
      expect(await s.status()).toMatchObject({ mailIdle: 'connected' });

      await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'PATCH', body: { enabled: false } });
      await s.tick();
      expect(s.idle()).toBe(0);
      expect(await s.status()).toMatchObject({ mailIdle: 'paused' });

      await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'PATCH', body: { enabled: true } });
      await s.tick();
      expect(s.idle()).toBe(1);
    });

    it('closes the connection when the Profile is deleted, and does not reconnect', async () => {
      const s = await scenario();
      await s.tick();

      await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'DELETE' });
      await s.tick();
      await s.tick(60_000);

      expect(s.idle()).toBe(0);
    });

    it('holds no connection while no mail rule is enabled', async () => {
      const s = await scenario(['Receipts']);
      const [rule] = await s.api.json<{ id: string }[]>(s.rulesPath);
      await s.tick();
      expect(s.idle()).toBe(1);

      await s.api.request(`${s.rulesPath}/${rule!.id}`, { method: 'PATCH', body: { enabled: false } });
      await s.tick();

      expect(s.idle()).toBe(0);
      expect(await s.status()).toMatchObject({ mailIdle: 'disconnected' });
    });

    it('reports reconnecting while the connection is down and disconnected for a Profile without mail rules', async () => {
      const s = await scenario();
      await s.tick();
      s.world.dropIdleConnections(s.appleId);
      expect(await s.status()).toMatchObject({ mailIdle: 'reconnecting' });

      const bare = await s.api.createProfile('Ben');
      expect(await s.api.json<ProfileStatusDto>(`/api/profiles/${bare.id}/status`)).toMatchObject({
        mailIdle: 'disconnected',
      });
    });
  });

  describe('polling of the other folders', () => {
    it('syncs a changed non-INBOX folder within a minute using STATUS, without further IDLE connections', async () => {
      const s = await scenario(['INBOX', 'Receipts']);
      await s.tick();
      s.world.statusRequests.length = 0;

      s.deliver('Receipts', 'Invoice');
      await s.tick(10_000);
      expect(s.gmail()).toEqual([]);

      await s.tick(50_000);
      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Invoice')]);
      // INBOX is watched by IDLE, so only the other folder is polled
      expect(s.world.statusRequests.flat().every((path) => path === 'Receipts')).toBe(true);
      expect(s.world.statusRequests.length).toBeGreaterThan(0);
      expect(s.idle()).toBe(1);
    });

    it('does not run a sync while nothing changed', async () => {
      const s = await scenario(['INBOX', 'Receipts']);
      await s.tick();
      await s.tick(60_000);
      const before = await s.lastSyncAt();

      await s.tick(60_000);
      await s.tick(60_000);

      expect(await s.lastSyncAt()).toBe(before);
    });

    it('syncs a rule that is created again for a folder nothing changed in', async () => {
      const s = await scenario(['INBOX']);
      const rule = await s.createRule('Receipts');
      s.deliver('Receipts', 'Invoice');
      await s.tick();
      await s.tick(60_000);
      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Invoice')]);

      // Delete the rule together with its Gmail messages (they go to the Trash), then create the same rule again
      await s.api.request(`${s.rulesPath}/${rule.id}?cleanupGoogle=true`, { method: 'DELETE' });
      expect(s.gmail().filter((m) => !m.labels.includes('TRASH'))).toEqual([]);
      await s.tick(60_000);
      await s.createRule('Receipts');
      await s.tick(1_000);

      expect(s.gmail().filter((m) => !m.labels.includes('TRASH')).map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Invoice')]);
    });

    it('polls INBOX too while its IDLE connection is down', async () => {
      const s = await scenario();
      s.world.failIdleConnects(s.appleId, 100);
      await s.tick();
      s.deliver('INBOX', 'Fallback');

      await s.tick(60_000);

      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Fallback')]);
    });

    it('retries on the next STATUS poll when the triggered mail sync failed transiently', async () => {
      const s = await scenario(['INBOX', 'Receipts']);
      await s.tick();

      s.deliver('Receipts', 'Retry Invoice');
      s.world.rejectImportsContaining('Subject: Retry Invoice');
      await s.tick(50_000);
      expect(s.gmail()).toEqual([]);

      // Without another folder change, the next poll retries once the outage is over
      s.world.clearImportRejections();
      await s.tick(50_000);
      expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Retry Invoice')]);
    });
  });
});
