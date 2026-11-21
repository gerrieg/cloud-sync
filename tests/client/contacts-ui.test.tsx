// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';
import type { SyncRunResult } from '../../src/shared/calendar.js';
import type { ContactGroupDiscovery, ContactRuleDto, ContactRunResult } from '../../src/shared/contacts.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import { installBackend, json, profile, type RecordedCall } from '../helpers/client-backend.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));

const BASE = '/api/profiles/a';

const DISCOVERY: ContactGroupDiscovery = {
  apple: [
    { uid: 'all', name: 'All Contacts' },
    { uid: 'g-fam', name: 'Familie' },
  ],
  google: [
    { resourceName: 'contactGroups/fam', name: 'Familie' },
    { resourceName: 'contactGroups/work', name: 'Arbeit' },
  ],
};

const EXISTING: ContactRuleDto = {
  id: 'c1',
  appleGroupUid: 'g-fam',
  appleGroupName: 'Familie',
  googleGroupResourceName: 'contactGroups/fam',
  googleGroupName: 'Familie Label',
  direction: 'one_way',
  enabled: true,
};

const RESULT: ContactRunResult = {
  status: 'ok',
  actions: [
    { action: 'create', uid: 'u1', summary: 'Max Muster' },
    { action: 'update', uid: 'u2', summary: 'Erika Muster', reason: 'labels_changed' },
    { action: 'delete', uid: 'u3', summary: 'Karl Alt', direction: 'google_to_apple' },
  ],
};

const BATCH: DeleteApprovalDto = {
  id: 'd9',
  domain: 'contacts',
  ruleId: null,
  label: 'Contacts',
  status: 'pending',
  createdAt: Date.UTC(2026, 0, 15, 12, 0, 0),
  items: [{ uid: 'u3', summary: 'Karl Alt', target: 'google' }],
};

function contactsBackend(options: { rules?: ContactRuleDto[]; pendingAfterSync?: DeleteApprovalDto[] } = {}) {
  const rules = [...(options.rules ?? [])];
  let pending: DeleteApprovalDto[] = [];
  const calls: RecordedCall[] = [];

  installBackend(
    [profile({ id: 'a', name: 'Anna', appleId: 'anna@icloud.com', appleConnected: true, googleConnected: true })],
    (call) => {
      calls.push(call);
      if (call.path === `${BASE}/discover/contact-groups`) return json(DISCOVERY);
      if (call.path === `${BASE}/rules/contacts` && call.method === 'GET') return json(rules);
      if (call.path === `${BASE}/rules/contacts` && call.method === 'POST') {
        const body = call.body as { appleGroupUid: string; googleGroupResourceName: string; direction?: ContactRuleDto['direction'] };
        const created: ContactRuleDto = {
          id: `c${rules.length + 1}`,
          appleGroupUid: body.appleGroupUid,
          appleGroupName: DISCOVERY.apple.find((g) => g.uid === body.appleGroupUid)!.name,
          googleGroupResourceName: body.googleGroupResourceName,
          googleGroupName: DISCOVERY.google.find((g) => g.resourceName === body.googleGroupResourceName)!.name,
          direction: body.direction ?? 'one_way',
          enabled: true,
        };
        rules.push(created);
        return json(created, 201);
      }
      const rule = new RegExp(`^${BASE}/rules/contacts/([^/?]+)(\\?cleanupGoogle=(true|false))?$`).exec(call.path);
      if (rule && call.method === 'PATCH') {
        const index = rules.findIndex((r) => r.id === rule[1]);
        rules[index] = { ...rules[index], ...(call.body as object) };
        return json(rules[index]);
      }
      if (rule && call.method === 'DELETE') {
        rules.splice(rules.findIndex((r) => r.id === rule[1]), 1);
        return new Response(null, { status: 204 });
      }
      if (call.path === `${BASE}/delete-approvals`) return json(pending);
      if (call.path === `${BASE}/dry-run` && call.method === 'POST') {
        return json({ dryRun: true, rules: [], contacts: RESULT } satisfies SyncRunResult);
      }
      if (call.path === `${BASE}/sync` && call.method === 'POST') {
        pending = options.pendingAfterSync ?? [];
        const contacts: ContactRunResult = pending.length ? { ...RESULT, deleteApprovalId: pending[0].id } : RESULT;
        return json({ dryRun: false, rules: [], contacts } satisfies SyncRunResult);
      }
      return undefined;
    },
  );
  return { calls, rules };
}

async function openPanel(options?: Parameters<typeof contactsBackend>[0]) {
  const backend = contactsBackend(options);
  render(<App />);
  await screen.findByRole('heading', { name: /contact sync/i });
  return backend;
}

describe('Contact sync UI (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists the rules and adds a rule for an Apple group and a Google label, one-way by default', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });
    expect(await screen.findByText(/Familie → Familie Label/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^apple group$/i), 'all');
    await user.selectOptions(screen.getByLabelText(/^google label$/i), 'contactGroups/work');
    await user.click(screen.getByRole('button', { name: /add contact rule/i }));

    expect(await screen.findByText(/All Contacts → Arbeit/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === `${BASE}/rules/contacts`)?.body).toEqual({
      appleGroupUid: 'all',
      googleGroupResourceName: 'contactGroups/work',
      direction: 'one_way',
    });
  });

  it('changes the direction and the active state of a rule', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });
    const row = (await screen.findByText(/Familie → Familie Label/)).closest('li')!;

    await user.selectOptions(within(row).getByLabelText(/^direction$/i), 'bidirectional');
    await user.click(within(row).getByLabelText(/^active$/i));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { direction: 'bidirectional' },
        { enabled: false },
      ]),
    );
  });

  describe('deleting a rule', () => {
    it('keeps the Google contacts by default and removes them only when the unchecked option is ticked', async () => {
      const user = userEvent.setup();
      const { calls } = await openPanel({ rules: [EXISTING] });
      const row = (await screen.findByText(/Familie → Familie Label/)).closest('li')!;

      await user.click(within(row).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog');
      const checkbox = within(dialog).getByRole('checkbox', { name: /remove the synced contacts from google/i });
      expect(checkbox).not.toBeChecked();
      await user.click(within(dialog).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() => expect(screen.queryByText(/Familie → Familie Label/)).not.toBeInTheDocument());
      expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`${BASE}/rules/contacts/c1?cleanupGoogle=false`);
    });

    it('sends cleanupGoogle=true after the opt-in', async () => {
      const user = userEvent.setup();
      const { calls } = await openPanel({ rules: [EXISTING] });
      const row = (await screen.findByText(/Familie → Familie Label/)).closest('li')!;

      await user.click(within(row).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('checkbox'));
      await user.click(within(dialog).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() =>
        expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`${BASE}/rules/contacts/c1?cleanupGoogle=true`),
      );
    });
  });

  it('previews with Dry-Run and syncs, always restricted to contacts', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });

    await user.click(screen.getByRole('button', { name: /preview contacts/i }));
    const results = await screen.findByRole('region', { name: /contact sync results/i });
    expect(within(results).getByText(/nothing was changed/i)).toBeInTheDocument();
    expect(within(results).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Create · Max Muster',
      'Update · Erika Muster (labels changed)',
      'Delete · Karl Alt · in Apple',
    ]);

    await user.click(screen.getByRole('button', { name: /sync contacts now/i }));
    await waitFor(() => expect(screen.getByText(/sync finished/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /resync all contacts/i }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && /\/(sync|dry-run)$/.test(c.path)).map((c) => [c.path, c.body])).toEqual([
        [`${BASE}/dry-run`, { domain: 'contacts' }],
        [`${BASE}/sync`, { domain: 'contacts', force: false }],
        [`${BASE}/sync`, { domain: 'contacts', force: true }],
      ]),
    );
  });

  it('shows the Delete Guard banner for a contact batch as soon as a contact sync halts deletions', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING], pendingAfterSync: [BATCH] });
    expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sync contacts now/i }));

    const banner = await screen.findByRole('alert', { name: /delete guard/i });
    expect(within(banner).getByText(/Contacts/)).toBeInTheDocument();
    expect(within(banner).getByText(/Karl Alt/)).toBeInTheDocument();
    expect(calls.some((c) => c.path === `${BASE}/delete-approvals`)).toBe(true);
  });
});
