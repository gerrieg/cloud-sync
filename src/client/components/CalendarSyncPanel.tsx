import { useEffect, useState } from 'react';
import { runDryRun, runSync, type CalendarRuleDto, type SyncRunResult } from '../lib/calendar-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { useCalendarRules } from '../lib/use-calendar-rules.js';
import { AddCalendarRuleForm } from './AddCalendarRuleForm.js';
import { CalendarRuleRow } from './CalendarRuleRow.js';
import { DeleteRuleDialog } from './DeleteRuleDialog.js';
import { SyncResults } from './SyncResults.js';

interface CalendarSyncPanelProps {
  profile: Profile;
}

export function CalendarSyncPanel({ profile }: CalendarSyncPanelProps) {
  if (!profile.appleConnected || !profile.googleConnected) {
    return (
      <p className="mt-6 text-sm text-slate-600">
        Connect both accounts to configure calendar sync for this Profile.
      </p>
    );
  }
  return <ConnectedCalendarSync profile={profile} />;
}

function ConnectedCalendarSync({ profile }: CalendarSyncPanelProps) {
  const { rules, discovery, loadError, add, update, remove } = useCalendarRules(profile.id);
  const [result, setResult] = useState<SyncRunResult | null>(null);
  const [deleting, setDeleting] = useState<CalendarRuleDto | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setResult(null);
    setDeleting(null);
    reset();
  }, [profile.id, reset]);

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Calendar sync</h2>
      <p className="mt-1 text-sm text-slate-600">
        Rules pair an Apple calendar with a Google calendar. Preview first: a Dry-Run changes nothing.
      </p>

      {rules.length > 0 && (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <CalendarRuleRow
              key={rule.id}
              rule={rule}
              busy={busy}
              onUpdate={(ruleId, patch) => void run(() => update(ruleId, patch))}
              onDelete={setDeleting}
            />
          ))}
        </ul>
      )}

      {discovery && <AddCalendarRuleForm discovery={discovery} busy={busy} onAdd={(rule) => void run(() => add(rule))} />}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setResult(await runDryRun(profile.id)))}
        >
          Preview (Dry-Run)
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setResult(await runSync(profile.id, false)))}
        >
          Sync Now
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          title="Pushes every Apple event again, undoing manual changes made in Google"
          onClick={() => void run(async () => setResult(await runSync(profile.id, true)))}
        >
          Force-Resync
        </button>
      </div>

      {(error ?? loadError) && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error ?? loadError}
        </p>
      )}
      {result && <SyncResults result={result} rules={rules} />}

      {deleting && (
        <DeleteRuleDialog
          rule={deleting}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={(cleanupGoogle) =>
            void run(async () => {
              await remove(deleting.id, cleanupGoogle);
              setDeleting(null);
            })
          }
        />
      )}
    </section>
  );
}
