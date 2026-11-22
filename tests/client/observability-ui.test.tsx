// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App.js';
import { installBackend, json, logEntry, overviewDomains, profile, type LogFixture, type RecordedCall } from '../helpers/client-backend.js';

vi.mock('../../src/client/lib/navigation.js', () => ({ redirectTo: vi.fn() }));

const SYNCED_AT = Date.UTC(2026, 0, 15, 9, 30, 0);

const isLogs = (call: RecordedCall) => call.method === 'GET' && call.path.startsWith('/api/logs');
const queryOf = (call: RecordedCall) => new URL(call.path, 'http://localhost').searchParams;

describe('Observability UI (fetch boundary)', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('Overview', () => {
    it('is the landing page and shows a card per Profile with last successful sync, live status and open errors', async () => {
      installBackend([profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })], (call) =>
        call.path === '/api/overview'
          ? json([
              {
                profile: profile({ id: 'a', name: 'Anna', lastSyncAt: SYNCED_AT + 60_000, lastSuccessfulSyncAt: SYNCED_AT, lastSyncStatus: 'error' }),
                status: { mailIdle: 'connected', googleCalendar: 'webhook' },
                domains: overviewDomains(),
                openErrors: 2,
              },
              {
                profile: profile({ id: 'b', name: 'Ben', enabled: false }),
                status: { mailIdle: 'paused', googleCalendar: 'inactive' },
                domains: overviewDomains(),
                openErrors: 0,
              },
            ])
          : undefined,
      );
      render(<App />);

      const anna = within(await screen.findByRole('article', { name: 'Anna' }));
      expect(anna.getByText(/last successful sync/i).closest('p')!.querySelector('time')).toHaveAttribute(
        'datetime',
        new Date(SYNCED_AT).toISOString(),
      );
      expect(anna.getByText('Mail IDLE: connected')).toBeInTheDocument();
      expect(anna.getByText('Google Calendar: webhook')).toBeInTheDocument();
      expect(anna.getByText(/2 open errors/i)).toBeInTheDocument();

      const ben = within(screen.getByRole('article', { name: 'Ben' }));
      expect(ben.getByText(/last successful sync: never/i)).toBeInTheDocument();
      expect(ben.getByText('Mail IDLE: paused')).toBeInTheDocument();
      expect(ben.getByText('Paused')).toBeInTheDocument();
    });

    it('shows per kind of data what is enabled, how the last run went and what the last 24 hours carried over', async () => {
      const now = Date.now();
      const run = { at: now - 3 * 60_000, durationMs: 1_400, status: 'ok' as const, created: 2, updated: 5, deleted: 0 };
      installBackend([profile({ id: 'a', name: 'Anna' })], (call) =>
        call.path === '/api/overview'
          ? json([
              {
                profile: profile({ id: 'a', name: 'Anna', lastSuccessfulSyncAt: now - 3 * 60_000 }),
                status: { mailIdle: 'connected', googleCalendar: 'webhook' },
                openErrors: 0,
                domains: overviewDomains({
                  calendars: { rulesEnabled: 2, rulesTotal: 3, direction: 'bidirectional', tracked: 340, lastRun: run, last24h: { runs: 40, failedRuns: 0, created: 7, updated: 12, deleted: 1 } },
                  contacts: { rulesEnabled: 1, rulesTotal: 1, direction: 'one_way', tracked: 141, lastRun: { ...run, status: 'skipped', durationMs: 120_000 }, last24h: { runs: 700, failedRuns: 2, created: 0, updated: 0, deleted: 0 } },
                  mail: { rulesEnabled: 1, rulesTotal: 1, direction: 'one_way', tracked: 2300, running: true },
                }),
              },
            ])
          : undefined,
      );
      render(<App />);

      const anna = within(await screen.findByRole('article', { name: 'Anna' }));
      const calendars = within(anna.getByRole('region', { name: 'Calendars' }));
      expect(calendars.getByText('2/3 rules on')).toBeInTheDocument();
      expect(calendars.getByLabelText('both ways')).toBeInTheDocument();
      expect(calendars.getByText('340 linked')).toBeInTheDocument();
      expect(calendars.getByLabelText('2 created, 5 updated, 0 deleted')).toBeInTheDocument();
      expect(calendars.getByText(/took 1\.4 s/)).toBeInTheDocument();
      expect(calendars.getByText('3 min ago')).toBeInTheDocument();
      expect(calendars.getByLabelText('7 created, 12 updated, 1 deleted')).toBeInTheDocument();

      const contacts = within(anna.getByRole('region', { name: 'Contacts' }));
      expect(contacts.getByText('no changes')).toBeInTheDocument();
      expect(contacts.getByText(/took 2 min 0 s/)).toBeInTheDocument();
      expect(contacts.getByText('2 failed runs')).toBeInTheDocument();

      const mail = within(anna.getByRole('region', { name: 'Mail' }));
      expect(mail.getByRole('status')).toHaveTextContent('Syncing…');
    });

    it('marks a failed run, an empty kind of data and a paused Profile', async () => {
      const now = Date.now();
      installBackend([profile({ id: 'a', name: 'Anna' })], (call) =>
        call.path === '/api/overview'
          ? json([
              {
                profile: profile({ id: 'a', name: 'Anna' }),
                status: { mailIdle: 'connected', googleCalendar: 'webhook' },
                openErrors: 1,
                domains: overviewDomains({
                  calendars: { rulesEnabled: 1, rulesTotal: 1, direction: 'one_way', lastRun: { at: now, durationMs: 800, status: 'error', created: 0, updated: 0, deleted: 0 } },
                  contacts: { rulesEnabled: 0, rulesTotal: 2 },
                }),
              },
              {
                profile: profile({ id: 'b', name: 'Ben', enabled: false }),
                status: { mailIdle: 'paused', googleCalendar: 'inactive' },
                openErrors: 0,
                domains: overviewDomains({ calendars: { rulesEnabled: 1, rulesTotal: 1, direction: 'one_way' } }),
              },
            ])
          : undefined,
      );
      render(<App />);

      const anna = within(await screen.findByRole('article', { name: 'Anna' }));
      expect(within(anna.getByRole('region', { name: 'Calendars' })).getByText('failed')).toBeInTheDocument();
      expect(within(anna.getByRole('region', { name: 'Contacts' })).getByText('0/2 rules on')).toBeInTheDocument();
      expect(within(anna.getByRole('region', { name: 'Mail' })).getByText('no rules')).toBeInTheDocument();

      const ben = within(screen.getByRole('article', { name: 'Ben' }));
      expect(within(ben.getByRole('region', { name: 'Calendars' })).getByText('paused')).toBeInTheDocument();
      expect(within(ben.getByRole('region', { name: 'Calendars' })).getByText('Not syncing')).toBeInTheDocument();
    });

    it('queues a sync for all Profiles from "Sync All" and says how many', async () => {
      const user = userEvent.setup();
      const backend = installBackend([profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })], (call) =>
        call.method === 'POST' && call.path === '/api/sync-all' ? json({ queued: ['a', 'b'] }, 202) : undefined,
      );
      render(<App />);
      await screen.findByRole('article', { name: 'Anna' });

      await user.click(screen.getByRole('button', { name: /sync all/i }));

      expect(await screen.findByText(/sync queued for 2 profiles/i)).toBeInTheDocument();
      expect(backend.calls.filter((call) => call.path === '/api/sync-all')).toHaveLength(1);
    });

    it('opens a Profile in its own dashboard', async () => {
      const user = userEvent.setup();
      installBackend([profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })]);
      render(<App />);
      await screen.findByRole('article', { name: 'Ben' });

      await user.click(within(screen.getByRole('article', { name: 'Ben' })).getByRole('button', { name: /open/i }));

      expect(await screen.findByRole('heading', { level: 1, name: 'Ben' })).toBeInTheDocument();
      expect(screen.getByRole('combobox', { name: /profile/i })).toHaveDisplayValue('Ben');
    });

    it('shows no Overview data error as a crash when the request fails', async () => {
      installBackend([profile({ id: 'a', name: 'Anna' })], (call) =>
        call.path === '/api/overview' ? json({ error: 'Overview unavailable' }, 500) : undefined,
      );
      render(<App />);

      expect(await screen.findByText('Overview unavailable')).toBeInTheDocument();
    });
  });

  describe('Errors tab', () => {
    const errors = [
      logEntry({ id: 'e1', summary: 'Zahnarzt', message: 'Google is down' }),
      logEntry({ id: 'e2', entityType: 'contact', ruleId: null, ruleName: null, summary: 'Anna Muster', message: 'People API down' }),
    ];

    /** The open errors are served until `resolved()` is true. */
    function withErrors(options: { retry?: (call: RecordedCall) => Response | undefined; open?: LogFixture[]; retryFixesErrors?: boolean } = {}) {
      let resolved = false;
      return {
        backend: installBackend([profile({ id: 'a', name: 'Anna' })], (call) => {
          if (isLogs(call) && queryOf(call).get('unresolvedOnly') === 'true') {
            return json(resolved ? [] : (options.open ?? errors));
          }
          const retried = options.retry?.(call);
          if (retried) {
            resolved = retried.ok && options.retryFixesErrors !== false;
            return retried;
          }
          return undefined;
        }),
      };
    }

    it('warns with a banner on every page while errors are open and links to the Errors tab', async () => {
      const user = userEvent.setup();
      withErrors();
      render(<App />);

      const banner = await screen.findByRole('alert');
      expect(banner).toHaveTextContent(/2 sync errors need attention/i);

      await user.click(within(banner).getByRole('button', { name: /show errors/i }));

      const list = await screen.findByRole('table', { name: /open errors/i });
      const rows = within(list).getAllByRole('row').slice(1);
      expect(rows).toHaveLength(2);
      expect(rows[0]).toHaveTextContent(/Anna.*Privat → Anna.*Zahnarzt.*Google is down/);
      expect(rows[1]).toHaveTextContent(/Anna.*Anna Muster.*People API down/);
      expect(screen.getByRole('tab', { name: /errors \(2\)/i })).toBeInTheDocument();
    });

    it('retries the affected Sync Rule and drops the errors that are resolved afterwards', async () => {
      const user = userEvent.setup();
      const { backend } = withErrors({
        open: [errors[0]!],
        retry: (call) =>
          call.method === 'POST' && call.path === '/api/profiles/a/rules/calendars/r1/retry'
            ? json({ dryRun: false, rules: [{ ruleId: 'r1', status: 'ok', actions: [] }] })
            : undefined,
      });
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /errors/i }));

      await user.click(await screen.findByRole('button', { name: /retry rule/i }));

      await waitFor(() => expect(screen.queryByRole('button', { name: /retry rule/i })).not.toBeInTheDocument());
      expect(await screen.findByText(/no open errors/i)).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(backend.calls.some((call) => call.method === 'POST' && call.path === '/api/profiles/a/rules/calendars/r1/retry')).toBe(true);
    });

    it('retries contact and mail rules through their own endpoints', async () => {
      const user = userEvent.setup();
      const { backend } = withErrors({
        open: [
          logEntry({ id: 'm1', entityType: 'email', ruleId: 'r9', ruleName: 'INBOX → INBOX', summary: 'Rechnung' }),
        ],
        retry: (call) => (call.method === 'POST' && call.path.endsWith('/retry') ? json({ dryRun: false, rules: [] }) : undefined),
      });
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /errors/i }));

      await user.click(await screen.findByRole('button', { name: /retry rule/i }));

      await waitFor(() => expect(backend.calls.some((call) => call.path === '/api/profiles/a/rules/mail/r9/retry')).toBe(true));
    });

    it('re-runs the whole domain for an error that belongs to no single rule', async () => {
      const user = userEvent.setup();
      const { backend } = withErrors({
        open: [errors[1]!],
        retry: (call) =>
          call.method === 'POST' && call.path === '/api/profiles/a/sync' ? json({ dryRun: false, rules: [] }) : undefined,
      });
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /errors/i }));

      await user.click(await screen.findByRole('button', { name: /retry sync/i }));

      await waitFor(() =>
        expect(backend.calls.find((call) => call.method === 'POST' && call.path === '/api/profiles/a/sync')?.body).toEqual({
          domain: 'contacts',
        }),
      );
    });

    it.each([
      ['a calendar rule that failed again', { dryRun: false, rules: [{ ruleId: 'r1', status: 'error', error: 'Still down', actions: [] }] }, 'Still down'],
      ['a calendar rule that is paused', { dryRun: false, rules: [{ ruleId: 'r1', status: 'skipped', reason: 'paused', actions: [] }] }, 'The rule is paused'],
    ])('explains why the error stays when the retry ran but did not help (%s)', async (_label, result, explanation) => {
      const user = userEvent.setup();
      withErrors({
        open: [errors[0]!],
        retryFixesErrors: false,
        retry: (call) => (call.path.endsWith('/retry') ? json(result) : undefined),
      });
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /errors/i }));

      await user.click(await screen.findByRole('button', { name: /retry rule/i }));

      expect(await screen.findByText(explanation)).toBeInTheDocument();
    });

    it('keeps the error and shows the reason when the retry request fails', async () => {
      const user = userEvent.setup();
      withErrors({
        open: [errors[0]!],
        retry: (call) => (call.path.endsWith('/retry') ? json({ error: 'This Profile is paused' }, 409) : undefined),
      });
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /errors/i }));

      await user.click(await screen.findByRole('button', { name: /retry rule/i }));

      expect(await screen.findByText('This Profile is paused')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /retry rule/i })).toBeInTheDocument();
    });
  });

  describe('Sync Log', () => {
    const entries = [
      logEntry({ id: 'i1', level: 'info', action: 'create', summary: 'Zahnarzt', message: '' }),
      logEntry({ id: 'i2', level: 'info', entityType: 'email', action: 'update', summary: 'Rechnung', message: 'flags_changed', ruleName: 'INBOX → INBOX' }),
    ];

    it('lists the log entries and reloads them with the chosen filters', async () => {
      const user = userEvent.setup();
      const backend = installBackend(
        [profile({ id: 'a', name: 'Anna' }), profile({ id: 'b', name: 'Ben' })],
        (call) => (isLogs(call) && queryOf(call).get('unresolvedOnly') !== 'true' ? json(entries) : undefined),
      );
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /sync log/i }));

      const table = await screen.findByRole('table', { name: /sync log/i });
      expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
      expect(within(table).getByText('Rechnung')).toBeInTheDocument();
      expect(within(table).getByText('flags_changed')).toBeInTheDocument();

      await user.selectOptions(screen.getByLabelText(/profile filter/i), 'b');
      await user.selectOptions(screen.getByLabelText(/^type$/i), 'email');
      await user.selectOptions(screen.getByLabelText(/^level$/i), 'error');
      await user.click(screen.getByLabelText(/unresolved errors only/i));

      await waitFor(() => {
        const last = backend.calls.filter((call) => isLogs(call) && queryOf(call).has('profileId')).at(-1)!;
        expect(Object.fromEntries(queryOf(last))).toMatchObject({
          profileId: 'b',
          entityType: 'email',
          level: 'error',
          unresolvedOnly: 'true',
        });
      });
    });

    it('shows an empty state', async () => {
      const user = userEvent.setup();
      installBackend([profile({ id: 'a', name: 'Anna' })]);
      render(<App />);
      await user.click(await screen.findByRole('tab', { name: /sync log/i }));

      expect(await screen.findByText(/no log entries/i)).toBeInTheDocument();
    });
  });
});
