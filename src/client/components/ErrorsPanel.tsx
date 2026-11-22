import { useState } from 'react';
import { ENTITY_TYPE_LABEL } from '../lib/log-labels.js';
import { retryError, type SyncLogDto } from '../lib/logs-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { TimeStamp } from './TimeStamp.js';

interface ErrorsPanelProps {
  errors: readonly SyncLogDto[];
  /** Called after a retry went through, so the list is read again. */
  onRetried(): Promise<void>;
}

/** The Errors tab: every open error with "Retry Rule", which re-runs the rule and closes what now works. */
export function ErrorsPanel({ errors, onRetried }: ErrorsPanelProps) {
  const [retrying, setRetrying] = useState<string | null>(null);
  const [failures, setFailures] = useState<Record<string, string>>({});

  async function handleRetry(error: SyncLogDto) {
    setRetrying(error.id);
    setFailures(({ [error.id]: _dropped, ...rest }) => rest);
    try {
      const problem = await retryError(error);
      await onRetried();
      if (problem) {
        setFailures((current) => ({ ...current, [error.id]: problem }));
      }
    } catch (cause) {
      setFailures((current) => ({ ...current, [error.id]: cause instanceof Error ? cause.message : 'Retry failed' }));
    } finally {
      setRetrying(null);
    }
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h1 className="text-xl font-semibold text-slate-900">Errors</h1>
      <p className="mt-1 text-sm text-slate-600">
        Items that could not be synced. The rest of each run still completed. A retry closes the errors of every
        item that works now.
      </p>

      {errors.length === 0 ? (
        <p className="mt-6 text-sm text-slate-600">No open errors.</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table aria-label="Open errors" className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500">
                <th className="py-2 pr-4 font-medium">Profile</th>
                <th className="py-2 pr-4 font-medium">Type</th>
                <th className="py-2 pr-4 font-medium">Rule</th>
                <th className="py-2 pr-4 font-medium">Item</th>
                <th className="py-2 pr-4 font-medium">Error</th>
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 font-medium">
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {errors.map((error) => (
                <tr key={error.id} className="border-b border-slate-100 align-top">
                  <td className="py-2 pr-4 whitespace-nowrap">{error.profileName}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{ENTITY_TYPE_LABEL[error.entityType]}</td>
                  <td className="py-2 pr-4 whitespace-nowrap">{error.ruleName ?? '—'}</td>
                  <td className="py-2 pr-4">{error.summary}</td>
                  <td className="py-2 pr-4 text-red-700">
                    {error.message}
                    {failures[error.id] && (
                      <p role="alert" className="mt-1 text-xs text-red-800">
                        {failures[error.id]}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-4 whitespace-nowrap text-slate-500">
                    <TimeStamp at={error.createdAt} />
                  </td>
                  <td className="py-2 whitespace-nowrap">
                    <button
                      type="button"
                      disabled={retrying !== null}
                      onClick={() => void handleRetry(error)}
                      className={secondaryButtonClass}
                    >
                      {error.ruleId ? 'Retry Rule' : 'Retry sync'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
