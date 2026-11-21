import type { ContactRunResult } from '../lib/contacts-api.js';

interface ContactSyncResultsProps {
  result: ContactRunResult;
  dryRun: boolean;
}

const ACTION_LABELS = { create: 'Create', update: 'Update', delete: 'Delete', skip: 'Skip' } as const;

export function ContactSyncResults({ result, dryRun }: ContactSyncResultsProps) {
  return (
    <section aria-label="Contact sync results" className="mt-5 rounded-lg bg-slate-50 p-4">
      <p className="text-sm font-medium text-slate-800">
        {dryRun ? 'Dry-Run preview: nothing was changed.' : 'Sync finished.'}
      </p>
      {result.status === 'skipped' && <p className="text-xs text-slate-500">Skipped ({result.reason}).</p>}
      {result.status === 'error' && (
        <p role="alert" className="text-xs text-red-700">
          {result.error}
        </p>
      )}
      {result.actions.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
          {result.actions.map((action, index) => (
            <li key={`${action.uid}-${index}`}>
              {`${ACTION_LABELS[action.action]} · ${action.summary}`}
              {action.reason ? ` (${action.reason.replaceAll('_', ' ')})` : ''}
              {action.direction === 'google_to_apple' ? ' · in Apple' : ''}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
