// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';
import type { SyncRunResult } from '../../src/shared/calendar.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import type { MailFolderDiscovery, MailRuleDto, MailRunResult } from '../../src/shared/mail.js';
import { installBackend, json, profile, type RecordedCall } from '../helpers/client-backend.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));

const BASE = '/api/profiles/a';

const DISCOVERY: MailFolderDiscovery = {
  folders: [
    { path: 'INBOX', name: 'INBOX', googleLabel: 'INBOX' },
    { path: 'Sent Messages', name: 'Sent Messages', googleLabel: 'SENT' },
    { path: 'Receipts', name: 'Receipts', googleLabel: 'Receipts' },
  ],
};

const EXISTING: MailRuleDto = {
  id: 'm1',
  appleFolderPath: 'INBOX',
  appleFolderName: 'INBOX',
  googleLabel: 'INBOX',
  syncWindowDays: 30,
  deleteBehavior: 'trash',
  enabled: true,
};

const RESULT: MailRunResult = {
  status: 'ok',
  actions: [
    { action: 'create', uid: 'id:a', summary: 'Hello there' },
    { action: 'update', uid: 'id:b', summary: 'Invoice', reason: 'moved' },
    { action: 'delete', uid: 'id:c', summary: 'Old news', reason: 'expunged' },
  ],
};

const BATCH: DeleteApprovalDto = {
  id: 'd9',
  domain: 'mail',
  ruleId: null,
  label: 'Mail',
  status: 'pending',
  createdAt: Date.UTC(2026, 0, 15, 12, 0, 0),
  items: [{ uid: 'id:c', summary: 'Old news', target: 'google' }],
};

function mailBackend(options: { rules?: MailRuleDto[]; pendingAfterSync?: DeleteApprovalDto[] } = {}) {
  const rules = [...(options.rules ?? [])];
  let pending: DeleteApprovalDto[] = [];
  const calls: RecordedCall[] = [];

  installBackend(
    [profile({ id: 'a', name: 'Anna', appleId: 'anna@icloud.com', appleConnected: true, googleConnected: true })],
    (call) => {
      calls.push(call);
      if (call.path === `${BASE}/discover/mail-folders`) return json(DISCOVERY);
      if (call.path === `${BASE}/rules/mail` && call.method === 'GET') return json(rules);
      if (call.path === `${BASE}/rules/mail` && call.method === 'POST') {
        const body = call.body as Partial<MailRuleDto> & { appleFolderPath: string };
        const folder = DISCOVERY.folders.find((f) => f.path === body.appleFolderPath)!;
        const created: MailRuleDto = {
          id: `m${rules.length + 1}`,
          appleFolderPath: folder.path,
          appleFolderName: folder.name,
          googleLabel: folder.googleLabel,
          syncWindowDays: body.syncWindowDays === undefined ? 30 : body.syncWindowDays,
          deleteBehavior: body.deleteBehavior ?? 'trash',
          enabled: true,
        };
        rules.push(created);
        return json(created, 201);
      }
      const rule = new RegExp(`^${BASE}/rules/mail/([^/?]+)(\\?cleanupGoogle=(true|false))?$`).exec(call.path);
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
        return json({ dryRun: true, rules: [], mail: RESULT } satisfies SyncRunResult);
      }
      if (call.path === `${BASE}/sync` && call.method === 'POST') {
        pending = options.pendingAfterSync ?? [];
        const mail: MailRunResult = pending.length ? { ...RESULT, deleteApprovalId: pending[0].id } : RESULT;
        return json({ dryRun: false, rules: [], mail } satisfies SyncRunResult);
      }
      return undefined;
    },
  );
  return { calls, rules };
}

async function openPanel(options?: Parameters<typeof mailBackend>[0]) {
  const backend = mailBackend(options);
  render(<App />);
  await screen.findByRole('heading', { name: /mail sync/i });
  return backend;
}

describe('Mail sync UI (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?view=profile');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('lists the rules and adds one, previewing the target Gmail label, with the defaults of the issue', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });
    expect(await screen.findByText(/INBOX → INBOX/)).toBeInTheDocument();

    const folder = screen.getByLabelText(/^icloud folder$/i);
    expect(screen.getByText('INBOX', { selector: 'p span' })).toBeInTheDocument();
    await user.selectOptions(folder, 'Sent Messages');
    expect(screen.getByText('SENT', { selector: 'p span' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add mail rule/i }));

    expect(await screen.findByText(/Sent Messages → SENT/)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST' && c.path === `${BASE}/rules/mail`)?.body).toEqual({
      appleFolderPath: 'Sent Messages',
      syncWindowDays: 30,
      deleteBehavior: 'trash',
    });
  });

  it('adds a rule that syncs all history and deletes permanently', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel();
    const form = (await screen.findByRole('button', { name: /add mail rule/i })).closest('form')!;

    await user.selectOptions(within(form).getByLabelText(/^start date$/i), 'all');
    await user.selectOptions(within(form).getByLabelText(/when deleted in icloud/i), 'delete');
    await user.click(within(form).getByRole('button', { name: /add mail rule/i }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'POST' && c.path === `${BASE}/rules/mail`)?.body).toEqual({
        appleFolderPath: 'INBOX',
        syncWindowDays: null,
        deleteBehavior: 'delete',
      }),
    );
  });

  it('changes start date, delete behavior and the active state of a rule', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });
    const row = (await screen.findByText(/INBOX → INBOX/)).closest('li')!;

    await user.selectOptions(within(row).getByLabelText(/^start date$/i), 'all');
    await user.selectOptions(within(row).getByLabelText(/when deleted in icloud/i), 'delete');
    await user.click(within(row).getByLabelText(/^active$/i));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { syncWindowDays: null },
        { deleteBehavior: 'delete' },
        { enabled: false },
      ]),
    );
  });

  describe('deleting a rule', () => {
    it('keeps the Gmail messages by default', async () => {
      const user = userEvent.setup();
      const { calls } = await openPanel({ rules: [EXISTING] });
      const row = (await screen.findByText(/INBOX → INBOX/)).closest('li')!;

      await user.click(within(row).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('checkbox', { name: /remove the synced emails from gmail/i })).not.toBeChecked();
      await user.click(within(dialog).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() => expect(screen.queryByText(/INBOX → INBOX/)).not.toBeInTheDocument());
      expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`${BASE}/rules/mail/m1?cleanupGoogle=false`);
    });

    it('sends cleanupGoogle=true after the opt-in', async () => {
      const user = userEvent.setup();
      const { calls } = await openPanel({ rules: [EXISTING] });
      const row = (await screen.findByText(/INBOX → INBOX/)).closest('li')!;

      await user.click(within(row).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('checkbox'));
      await user.click(within(dialog).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() =>
        expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(`${BASE}/rules/mail/m1?cleanupGoogle=true`),
      );
    });
  });

  it('previews with Dry-Run and syncs, always restricted to mail', async () => {
    const user = userEvent.setup();
    const { calls } = await openPanel({ rules: [EXISTING] });

    await user.click(screen.getByRole('button', { name: /preview mail/i }));
    const results = await screen.findByRole('region', { name: /mail sync results/i });
    expect(within(results).getByText(/nothing was changed/i)).toBeInTheDocument();
    expect(within(results).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      'Import · Hello there',
      'Update · Invoice (moved)',
      'Delete · Old news (expunged)',
    ]);

    await user.click(screen.getByRole('button', { name: /sync mail now/i }));
    await waitFor(() => expect(screen.getByText(/sync finished/i)).toBeInTheDocument());
    await user.click(screen.getByRole('button', { name: /resync all mail/i }));

    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'POST' && /\/(sync|dry-run)$/.test(c.path)).map((c) => [c.path, c.body])).toEqual([
        [`${BASE}/dry-run`, { domain: 'mail' }],
        [`${BASE}/sync`, { domain: 'mail', force: false }],
        [`${BASE}/sync`, { domain: 'mail', force: true }],
      ]),
    );
  });

  it('shows the Delete Guard banner for a mail batch as soon as a mail sync halts deletions', async () => {
    const user = userEvent.setup();
    await openPanel({ rules: [EXISTING], pendingAfterSync: [BATCH] });
    expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sync mail now/i }));

    const banner = await screen.findByRole('alert', { name: /delete guard/i });
    expect(within(banner).getByText(/Mail/)).toBeInTheDocument();
    expect(within(banner).getByText(/Old news/)).toBeInTheDocument();
  });
});
