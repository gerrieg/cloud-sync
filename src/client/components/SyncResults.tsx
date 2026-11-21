import type { CalendarRuleDto, SyncRunResult } from '../lib/calendar-api.js';

interface SyncResultsProps {
  result: SyncRunResult;
  rules: readonly CalendarRuleDto[];
}

const ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', skip: 'Skip' } as const;

export function SyncResults({ result, rules }: SyncResultsProps) {
  return (
    <section aria-label="Sync results" className="mt-5 rounded-lg bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-800">
        {result.dryRun ? 'Dry-Run preview: nothing was changed.' : 'Sync finished.'}
      </p>
      {result.rules.map((entry) => {
        const rule = rules.find((r) => r.id === entry.ruleId);
        return (
          <div key={entry.ruleId} className="mt-3">
            <h3 className="text-sm font-semibold text-slate-700">
              {rule ? `${rule.appleCalendarName} → ${rule.googleCalendarName}` : entry.ruleId}
            </h3>
            {entry.status === 'skipped' && (
              <p className="text-xs text-slate-500">Skipped ({entry.reason}).</p>
            )}
            {entry.status === 'error' && (
              <p role="alert" className="text-xs text-red-700">
                {entry.error}
              </p>
            )}
            {entry.actions.length > 0 && (
              <ul className="mt-1 space-y-0.5 text-sm text-slate-700">
                {entry.actions.map((action, index) => (
                  <li key={`${action.uid}-${index}`}>
                    {`${ACTION_LABELS[action.action]} · ${action.summary}`}
                    {action.reason ? ` (${action.reason.replaceAll('_', ' ')})` : ''}
                    {action.foreignInvitation ? ' · invitation from someone else' : ''}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
