// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';
import type {
  CalendarDiscovery,
  CalendarRuleDto,
  SyncRunResult,
} from '../../src/shared/calendar.js';
import {
  installBackend,
  json,
  profile,
  type ProfileFixture,
  type RecordedCall,
} from '../helpers/client-backend.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));

const DISCOVERY: CalendarDiscovery = {
  apple: [
    { url: '/cal/home/', name: 'Privat', readOnly: false, subscribed: false },
    { url: '/cal/holidays/', name: 'Feiertage', readOnly: true, subscribed: true },
  ],
  google: [
    { id: 'primary', name: 'Anna', primary: true, writable: true },
    { id: 'family', name: 'Familie', primary: false, writable: true },
    { id: 'shared', name: 'Fremd', primary: false, writable: false },
  ],
};

const EXISTING_RULE: CalendarRuleDto = {
  id: 'r1',
  appleCalendarUrl: '/cal/home/',
  appleCalendarName: 'Privat',
  appleReadOnly: false,
  googleCalendarId: 'primary',
  googleCalendarName: 'Anna',
  direction: 'one_way',
  syncWindowDays: 30,
  syncReminders: false,
  enabled: true,
};

const RESULT: SyncRunResult = {
  dryRun: true,
  rules: [
    {
      ruleId: 'r1',
      status: 'ok',
      actions: [
        { action: 'create', ruleId: 'r1', uid: 'u1', summary: 'Zahnarzt', foreignInvitation: false },
        { action: 'skip', ruleId: 'r1', uid: 'u2', summary: 'Kurs', reason: 'unchanged' },
        { action: 'delete', ruleId: 'r1', uid: 'u3', summary: 'Geburtstag Oma' },
      ],
    },
  ],
};

const CONNECTED: ProfileFixture = profile({
  id: 'a',
  name: 'Anna',
  appleId: 'anna@icloud.com',
  appleConnected: true,
  googleConnected: true,
});

const BASE = '/api/profiles/a';

/** Stateful stand-in for the calendar endpoints of one Profile. */
function calendarBackend(initialRules: CalendarRuleDto[] = [], profileFixture = CONNECTED) {
  const rules = [...initialRules];
  const calls: RecordedCall[] = [];

  const backend = installBackend([profileFixture], (call) => {
    calls.push(call);
    if (call.path === `${BASE}/discover/calendars`) return json(DISCOVERY);
    if (call.path === `${BASE}/rules/calendars` && call.method === 'GET') return json(rules);
    if (call.path === `${BASE}/rules/calendars` && call.method === 'POST') {
      const body = call.body as { appleCalendarUrl: string; googleCalendarId: string } & Partial<CalendarRuleDto>;
      const apple = DISCOVERY.apple.find((c) => c.url === body.appleCalendarUrl)!;
      const google = DISCOVERY.google.find((c) => c.id === body.googleCalendarId)!;
      const created: CalendarRuleDto = {
        id: `r${rules.length + 1}`,
        appleCalendarUrl: apple.url,
        appleCalendarName: apple.name,
        appleReadOnly: apple.readOnly,
        googleCalendarId: google.id,
        googleCalendarName: google.name,
        direction: apple.readOnly ? 'one_way' : (body.direction ?? 'one_way'),
        syncWindowDays: body.syncWindowDays === undefined ? 30 : body.syncWindowDays,
        syncReminders: body.syncReminders ?? false,
        enabled: true,
      };
      rules.push(created);
      return json(created, 201);
    }
    const ruleMatch = new RegExp(`^${BASE}/rules/calendars/([^/?]+)(\\?cleanupGoogle=(true|false))?$`).exec(call.path);
    if (ruleMatch && call.method === 'PATCH') {
      const index = rules.findIndex((r) => r.id === ruleMatch[1]);
      rules[index] = { ...rules[index], ...(call.body as object) };
      return json(rules[index]);
    }
    if (ruleMatch && call.method === 'DELETE') {
      rules.splice(rules.findIndex((r) => r.id === ruleMatch[1]), 1);
      return new Response(null, { status: 204 });
    }
    if (call.path === `${BASE}/dry-run` && call.method === 'POST') return json(RESULT);
    if (call.path === `${BASE}/sync` && call.method === 'POST') return json({ ...RESULT, dryRun: false });
    return undefined;
  });

  return { ...backend, calls, rules };
}

async function openPanel(initialRules: CalendarRuleDto[] = []) {
  const backend = calendarBackend(initialRules);
  render(<App />);
  await screen.findByRole('heading', { name: /calendar sync/i });
  return backend;
}

describe('Calendar sync UI (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/?view=profile');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('asks to connect both accounts first when the Profile is not fully connected', async () => {
    installBackend([profile({ id: 'a', name: 'Anna' })]);
    render(<App />);

    expect(await screen.findByText(/connect both accounts/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /calendar sync/i })).not.toBeInTheDocument();
  });

  it('lists the existing rules and adds a rule with the safe defaults', async () => {
    const user = userEvent.setup();
    const backend = await openPanel([EXISTING_RULE]);

    expect(await screen.findByText(/Privat → Anna/)).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText(/^apple calendar$/i), '/cal/home/');
    // Only writable Google calendars can be chosen
    const googleOptions = within(screen.getByLabelText(/^google calendar$/i)).getAllByRole('option');
    expect(googleOptions.map((o) => o.textContent)).toEqual(['Anna', 'Familie']);
    await user.selectOptions(screen.getByLabelText(/^google calendar$/i), 'family');
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    expect(await screen.findByText(/Privat → Familie/)).toBeInTheDocument();
    expect(backend.calls.find((c) => c.method === 'POST' && c.path === `${BASE}/rules/calendars`)?.body).toEqual({
      appleCalendarUrl: '/cal/home/',
      googleCalendarId: 'family',
      direction: 'one_way',
      syncWindowDays: 30,
      syncReminders: false,
    });
  });

  it('locks the direction to one-way for read-only Apple calendars', async () => {
    const user = userEvent.setup();
    await openPanel();

    await user.selectOptions(await screen.findByLabelText(/^apple calendar$/i), '/cal/holidays/');

    const direction = screen.getByLabelText(/^direction$/i);
    expect(direction).toBeDisabled();
    expect(direction).toHaveDisplayValue(/apple → google/i);
    expect(screen.getByText(/read-only calendars sync one-way/i)).toBeInTheDocument();
  });

  it('lets the admin choose the direction, with a note on how Google changes are handled', async () => {
    const user = userEvent.setup();
    const backend = await openPanel();

    await user.selectOptions(await screen.findByLabelText(/^direction$/i), 'bidirectional');
    expect(screen.getByText(/uncontested google edits and deletions are carried over to apple/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /add rule/i }));

    await screen.findByText(/Privat → Anna/);
    expect(backend.calls.find((c) => c.method === 'POST' && c.path === `${BASE}/rules/calendars`)?.body).toMatchObject({
      direction: 'bidirectional',
    });

    const row = screen.getByText(/Privat → Anna/).closest('li')!;
    await user.selectOptions(within(row).getByLabelText(/^direction$/i), 'one_way');
    await waitFor(() =>
      expect(backend.calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([
        { direction: 'one_way' },
      ]),
    );
  });

  it('updates the active flag, the history window and reminders of a rule', async () => {
    const user = userEvent.setup();
    const backend = await openPanel([EXISTING_RULE]);
    const row = (await screen.findByText(/Privat → Anna/)).closest('li')!;

    await user.click(within(row).getByLabelText(/^active$/i));
    await user.selectOptions(within(row).getByLabelText(/history window/i), 'all');
    await user.click(within(row).getByLabelText(/sync reminders/i));

    await waitFor(() => {
      const patches = backend.calls.filter((c) => c.method === 'PATCH').map((c) => c.body);
      expect(patches).toEqual([{ enabled: false }, { syncWindowDays: null }, { syncReminders: true }]);
    });
  });

  it('previews with Dry-Run, then runs Sync Now and Force-Resync', async () => {
    const user = userEvent.setup();
    const backend = await openPanel([EXISTING_RULE]);

    await user.click(screen.getByRole('button', { name: /preview \(dry-run\)/i }));

    const results = await screen.findByRole('region', { name: /sync results/i });
    expect(results).toHaveTextContent(/nothing was changed/i);
    expect(within(results).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
      expect.stringMatching(/create.*Zahnarzt/i),
      expect.stringMatching(/skip.*Kurs.*unchanged/i),
      expect.stringMatching(/delete.*Geburtstag Oma/i),
    ]);

    await user.click(screen.getByRole('button', { name: /^sync now$/i }));
    await user.click(screen.getByRole('button', { name: /force-resync/i }));

    await waitFor(() => {
      const runs = backend.calls
        .filter((c) => c.method === 'POST' && /\/(sync|dry-run)$/.test(c.path))
        .map((c) => [c.path.split('/').pop(), c.body]);
      expect(runs).toEqual([
        ['dry-run', {}],
        ['sync', { force: false }],
        ['sync', { force: true }],
      ]);
    });
  });

  it('shows the server error, e.g. when Google needs re-authentication', async () => {
    const user = userEvent.setup();
    installBackend([CONNECTED], (call) => {
      if (call.path === `${BASE}/discover/calendars`) return json(DISCOVERY);
      if (call.path === `${BASE}/rules/calendars`) return json([]);
      if (call.path === `${BASE}/sync`) {
        return json({ error: 'Google authorization expired; please re-authenticate', reauthRequired: true }, 409);
      }
      return undefined;
    });
    render(<App />);
    await screen.findByRole('heading', { name: /calendar sync/i });

    await user.click(screen.getByRole('button', { name: /^sync now$/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/re-authenticate/i);
  });

  describe('deleting a rule', () => {
    it('keeps the Google events unless the unchecked cleanup option is ticked', async () => {
      const user = userEvent.setup();
      const backend = await openPanel([
        EXISTING_RULE,
        { ...EXISTING_RULE, id: 'r2', googleCalendarId: 'family', googleCalendarName: 'Familie' },
      ]);

      const firstRow = (await screen.findByText(/Privat → Anna/)).closest('li')!;
      await user.click(within(firstRow).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog', { name: /delete calendar rule/i });
      const cleanup = within(dialog).getByLabelText(/also remove the synced events from google/i);
      expect(cleanup).not.toBeChecked();
      await user.click(within(dialog).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() => expect(screen.queryByText(/Privat → Anna/)).not.toBeInTheDocument());
      expect(backend.calls.find((c) => c.method === 'DELETE')?.path).toBe(`${BASE}/rules/calendars/r1?cleanupGoogle=false`);

      const secondRow = screen.getByText(/Privat → Familie/).closest('li')!;
      await user.click(within(secondRow).getByRole('button', { name: /delete rule/i }));
      const second = await screen.findByRole('dialog', { name: /delete calendar rule/i });
      await user.click(within(second).getByLabelText(/also remove the synced events from google/i));
      await user.click(within(second).getByRole('button', { name: /confirm delete/i }));

      await waitFor(() => expect(screen.queryByText(/Privat → Familie/)).not.toBeInTheDocument());
      expect(backend.calls.filter((c) => c.method === 'DELETE').at(-1)?.path).toBe(
        `${BASE}/rules/calendars/r2?cleanupGoogle=true`,
      );
    });

    it('does nothing when the dialog is cancelled', async () => {
      const user = userEvent.setup();
      const backend = await openPanel([EXISTING_RULE]);
      const row = (await screen.findByText(/Privat → Anna/)).closest('li')!;

      await user.click(within(row).getByRole('button', { name: /delete rule/i }));
      const dialog = await screen.findByRole('dialog', { name: /delete calendar rule/i });
      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(backend.calls.some((c) => c.method === 'DELETE')).toBe(false);
      expect(screen.getByText(/Privat → Anna/)).toBeInTheDocument();
    });
  });
});
