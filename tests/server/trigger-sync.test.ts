import { afterEach, describe, expect, it } from 'vitest';
import { setupMail } from '../helpers/mail-scenario.js';

describe('POST /api/trigger-sync/:profileId', () => {
  let close: (() => void) | undefined;
  afterEach(() => close?.());

  async function scenario() {
    const mail = await setupMail();
    close = () => mail.ctx.close();
    await mail.createRule('INBOX');
    mail.deliver('INBOX', 'Hello');
    const { token } = await mail.api.json<{ token: string }>(`/api/profiles/${mail.profile.id}/trigger-token`);
    const trigger = (headers: Record<string, string>, profileId = mail.profile.id) =>
      mail.ctx.app.request(`/api/trigger-sync/${profileId}`, { method: 'POST', headers });
    return { ...mail, token, trigger };
  }

  it('queues an immediate Profile sync for a valid Bearer trigger token, without a session', async () => {
    const s = await scenario();

    const response = await s.trigger({ authorization: `Bearer ${s.token}` });
    expect(response.status).toBe(202);
    await s.ctx.realtime.settled();

    expect(s.gmail().map((m) => m.raw)).toEqual([expect.stringContaining('Subject: Hello')]);
  });

  it.each([
    ['a missing Authorization header', {}],
    ['a wrong token', { authorization: 'Bearer not-the-token' }],
    ['a non-Bearer scheme', { authorization: 'Basic abc' }],
  ])('answers 401 without redirecting or syncing for %s', async (_label, headers) => {
    const s = await scenario();

    const response = await s.trigger(headers);
    expect(response.status).toBe(401);
    await s.ctx.realtime.settled();

    expect(s.gmail()).toEqual([]);
  });

  it("does not accept another Profile's token nor reveal whether a Profile exists", async () => {
    const s = await scenario();
    const other = await s.api.createProfile('Ben');
    const { token: otherToken } = await s.api.json<{ token: string }>(`/api/profiles/${other.id}/trigger-token`);

    expect((await s.trigger({ authorization: `Bearer ${otherToken}` })).status).toBe(401);
    expect((await s.trigger({ authorization: `Bearer ${s.token}` }, 'no-such-profile')).status).toBe(401);
  });

  it('refuses a rotated-away token', async () => {
    const s = await scenario();
    await s.api.request(`/api/profiles/${s.profile.id}/rotate-trigger-token`, { method: 'POST' });

    expect((await s.trigger({ authorization: `Bearer ${s.token}` })).status).toBe(401);
  });

  it('answers 409 for a paused Profile and syncs nothing', async () => {
    const s = await scenario();
    await s.api.request(`/api/profiles/${s.profile.id}`, { method: 'PATCH', body: { enabled: false } });

    const response = await s.trigger({ authorization: `Bearer ${s.token}` });
    expect(response.status).toBe(409);
    await s.ctx.realtime.settled();

    expect(s.gmail()).toEqual([]);
  });
});
