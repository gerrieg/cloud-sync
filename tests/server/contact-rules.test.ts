import { afterEach, describe, expect, it } from 'vitest';
import type { ContactGroupDiscovery, ContactRuleDto } from '../../src/shared/contacts.js';
import {
  ARBEIT_GROUP,
  FAMILIE_GROUP,
  G_ARBEIT,
  G_FAMILIE,
  appleCard,
  groupCard,
  setupContacts,
} from '../helpers/contacts-scenario.js';

describe('Contact groups discovery and Contact Group Sync Rules HTTP seam', () => {
  let close: (() => void) | undefined;

  afterEach(() => {
    close?.();
    close = undefined;
  });

  async function setup() {
    const scenario = await setupContacts();
    close = () => scenario.ctx.close();
    const { world, appleId } = scenario;
    world.putAppleVCard(appleId, '/card/familie.vcf', groupCard(FAMILIE_GROUP, 'Familie', ['u1']));
    world.putAppleVCard(appleId, '/card/arbeit.vcf', groupCard(ARBEIT_GROUP, 'Arbeit', []));
    world.putAppleVCard(appleId, '/card/u1.vcf', appleCard('u1', 'Max', 'Muster'));
    return scenario;
  }

  it('discovers Apple vCard groups (plus All Contacts, but no plain contacts) and Google labels', async () => {
    const { api, profile } = await setup();

    const res = await api.request(`/api/profiles/${profile.id}/discover/contact-groups`);

    expect(res.status).toBe(200);
    expect((await res.json()) as ContactGroupDiscovery).toEqual({
      apple: [
        { uid: 'all', name: 'All Contacts' },
        { uid: FAMILIE_GROUP, name: 'Familie' },
        { uid: ARBEIT_GROUP, name: 'Arbeit' },
      ],
      google: [
        { resourceName: G_FAMILIE, name: 'Familie' },
        { resourceName: G_ARBEIT, name: 'Arbeit' },
      ],
    });
  });

  it('requires both accounts to be connected', async () => {
    const { api } = await setup();
    const unconnected = await api.createProfile('Ben');

    expect((await api.request(`/api/profiles/${unconnected.id}/discover/contact-groups`)).status).toBe(409);
  });

  it('creates, lists, updates and deletes rules; one-way and active by default', async () => {
    const { api, rulesPath } = await setup();
    const createRule = (body: Record<string, unknown>) => api.request(rulesPath, { method: 'POST', body });

    const created = await createRule({ appleGroupUid: FAMILIE_GROUP, googleGroupResourceName: G_FAMILIE });
    expect(created.status).toBe(201);
    const rule = (await created.json()) as ContactRuleDto;
    expect(rule).toMatchObject({
      appleGroupUid: FAMILIE_GROUP,
      appleGroupName: 'Familie',
      googleGroupResourceName: G_FAMILIE,
      googleGroupName: 'Familie',
      direction: 'one_way',
      enabled: true,
    });
    const all = await createRule({
      appleGroupUid: 'all',
      googleGroupResourceName: G_ARBEIT,
      direction: 'bidirectional',
    });
    expect(((await all.json()) as ContactRuleDto)).toMatchObject({ appleGroupName: 'All Contacts', direction: 'bidirectional' });
    expect(await api.json<ContactRuleDto[]>(rulesPath)).toHaveLength(2);

    const patched = await api.request(`${rulesPath}/${rule.id}`, {
      method: 'PATCH',
      body: { direction: 'bidirectional', enabled: false },
    });
    expect(await patched.json()).toMatchObject({ id: rule.id, direction: 'bidirectional', enabled: false });

    const removed = await api.request(`${rulesPath}/${rule.id}`, { method: 'DELETE' });
    expect(removed.status).toBe(204);
    expect((await api.json<ContactRuleDto[]>(rulesPath)).map((r) => r.id)).not.toContain(rule.id);
  });

  it('rejects invalid input, unknown groups, duplicate pairs and unknown rules', async () => {
    const { api, rulesPath } = await setup();
    const createRule = (body: Record<string, unknown>) => api.request(rulesPath, { method: 'POST', body });
    await createRule({ appleGroupUid: FAMILIE_GROUP, googleGroupResourceName: G_FAMILIE });

    expect((await createRule({ appleGroupUid: FAMILIE_GROUP })).status).toBe(400);
    expect((await createRule({ appleGroupUid: FAMILIE_GROUP, googleGroupResourceName: G_ARBEIT, direction: 'sideways' })).status).toBe(400);
    expect((await createRule({ appleGroupUid: 'unknown', googleGroupResourceName: G_ARBEIT })).status).toBe(400);
    expect((await createRule({ appleGroupUid: FAMILIE_GROUP, googleGroupResourceName: 'contactGroups/none' })).status).toBe(400);
    expect((await createRule({ appleGroupUid: FAMILIE_GROUP, googleGroupResourceName: G_FAMILIE })).status).toBe(409);
    expect((await api.request(`${rulesPath}/unknown`, { method: 'PATCH', body: { enabled: false } })).status).toBe(404);
    expect((await api.request(`${rulesPath}/unknown`, { method: 'DELETE' })).status).toBe(404);
    const rule = (await api.json<ContactRuleDto[]>(rulesPath))[0];
    expect((await api.request(`${rulesPath}/${rule.id}`, { method: 'PATCH', body: { direction: 'x' } })).status).toBe(400);
    expect((await api.request(`${rulesPath}/${rule.id}?cleanupGoogle=maybe`, { method: 'DELETE' })).status).toBe(400);
  });
});
