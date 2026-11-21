import type { MailRunResult } from '../lib/mail-api.js';

interface MailSyncResultsProps {
  result: MailRunResult;
  dryRun: boolean;
}

const ACTION_LABELS = { create: 'Import', update: 'Update', delete: 'Delete', skip: 'Skip' } as const;

export function MailSyncResults({ result, dryRun }: MailSyncResultsProps) {
  return (
    <section aria-label="Mail sync results" className="mt-5 rounded-lg bg-slate-50 p-4">
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
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
