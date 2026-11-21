// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';
import type { CalendarRuleDto, SyncRunResult } from '../../src/shared/calendar.js';
import type { DeleteApprovalDto } from '../../src/shared/delete-guard.js';
import { installBackend, json, profile, type RecordedCall } from '../helpers/client-backend.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));

const BASE = '/api/profiles/a';

const RULE: CalendarRuleDto = {
  id: 'r1',
  appleCalendarUrl: '/cal/home/',
  appleCalendarName: 'Privat',
  appleReadOnly: false,
  googleCalendarId: 'primary',
  googleCalendarName: 'Anna',
  direction: 'bidirectional',
  syncWindowDays: 30,
  syncReminders: false,
  enabled: true,
};

const BATCH: DeleteApprovalDto = {
  id: 'd1',
  domain: 'calendar',
  ruleId: 'r1',
  label: 'Privat → Anna',
  status: 'pending',
  createdAt: Date.UTC(2026, 0, 15, 12, 0, 0),
  items: [
    { uid: 'u1', summary: 'Zahnarzt', target: 'google' },
    { uid: 'u2', summary: 'Geburtstag Oma', target: 'apple' },
  ],
};

/** Stateful stand-in for the calendar and Delete Guard endpoints of one Profile. */
function backend(options: { pending?: DeleteApprovalDto[]; pendingAfterSync?: DeleteApprovalDto[]; failApprove?: boolean } = {}) {
  let pending = [...(options.pending ?? [])];
  const calls: RecordedCall[] = [];

  installBackend(
    [
      profile({
        id: 'a',
        name: 'Anna',
        appleId: 'anna@icloud.com',
        appleConnected: true,
        googleConnected: true,
      }),
    ],
    (call) => {
      calls.push(call);
      if (call.path === `${BASE}/discover/calendars`) return json({ apple: [], google: [] });
      if (call.path === `${BASE}/rules/calendars` && call.method === 'GET') return json([RULE]);
      if (call.path === `${BASE}/delete-approvals`) return json(pending);
      if (call.path === `${BASE}/sync` && call.method === 'POST') {
        pending = [...(options.pendingAfterSync ?? pending)];
        const result: SyncRunResult = {
          dryRun: false,
          rules: [{ ruleId: 'r1', status: 'ok', deleteApprovalId: 'd1', actions: [] }],
        };
        return json(result);
      }
      const decision = /^\/api\/delete-approvals\/([^/]+)\/(approve|dismiss)$/.exec(call.path);
      if (decision && call.method === 'POST') {
        if (options.failApprove && decision[2] === 'approve') {
          return json({ error: 'Could not execute the deletions; the batch is still pending' }, 502);
        }
        const resolved = pending.find((p) => p.id === decision[1]);
        pending = pending.filter((p) => p.id !== decision[1]);
        return json({ ...resolved, status: decision[2] === 'approve' ? 'approved' : 'dismissed' });
      }
      return undefined;
    },
  );
  return { calls };
}

describe('Delete Guard banner (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('shows no banner when nothing is pending', async () => {
    backend();
    render(<App />);
    await screen.findByRole('heading', { name: /calendar sync/i });

    expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument();
  });

  it('lists the pending batch with its affected items and the rule it belongs to', async () => {
    backend({ pending: [BATCH] });
    render(<App />);

    const banner = await screen.findByRole('alert', { name: /delete guard/i });

    expect(within(banner).getByText(/Privat → Anna/)).toBeInTheDocument();
    expect(within(banner).getByText(/Zahnarzt/)).toBeInTheDocument();
    expect(within(banner).getByText(/Geburtstag Oma/)).toBeInTheDocument();
    expect(within(banner).getByText(/delete from google/i)).toBeInTheDocument();
    expect(within(banner).getByText(/delete from apple/i)).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /approve/i })).toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: /dismiss/i })).toBeInTheDocument();
  });

  it('approves a batch through the API and removes the banner', async () => {
    const user = userEvent.setup();
    const { calls } = backend({ pending: [BATCH] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /approve/i }));

    await waitFor(() => expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/delete-approvals'))).toEqual([
      expect.objectContaining({ path: '/api/delete-approvals/d1/approve' }),
    ]);
  });

  it('dismisses a batch through the API and removes the banner', async () => {
    const user = userEvent.setup();
    const { calls } = backend({ pending: [BATCH] });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /dismiss/i }));

    await waitFor(() => expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument());
    expect(calls.filter((c) => c.method === 'POST' && c.path.startsWith('/api/delete-approvals'))).toEqual([
      expect.objectContaining({ path: '/api/delete-approvals/d1/dismiss' }),
    ]);
  });

  it('keeps the batch and shows the error when approving fails', async () => {
    const user = userEvent.setup();
    backend({ pending: [BATCH], failApprove: true });
    render(<App />);

    await user.click(await screen.findByRole('button', { name: /approve/i }));

    expect(await screen.findByText(/the batch is still pending/i)).toBeInTheDocument();
    expect(screen.getByRole('alert', { name: /delete guard/i })).toBeInTheDocument();
  });

  it('shows the banner as soon as a sync run halts deletions', async () => {
    const user = userEvent.setup();
    backend({ pending: [], pendingAfterSync: [BATCH] });
    render(<App />);
    await screen.findByRole('heading', { name: /calendar sync/i });
    expect(screen.queryByRole('alert', { name: /delete guard/i })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sync now/i }));

    const banner = await screen.findByRole('alert', { name: /delete guard/i });
    expect(within(banner).getByText(/Zahnarzt/)).toBeInTheDocument();
  });
});
