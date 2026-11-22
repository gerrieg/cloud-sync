import type { DeleteApprovalDto } from '../lib/delete-approvals-api.js';
import { secondaryButtonClass, warningButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';

interface DeleteGuardBannerProps {
  approvals: readonly DeleteApprovalDto[];
  onApprove(approvalId: string): Promise<void>;
  onDismiss(approvalId: string): Promise<void>;
}

const TARGET_LABELS = { apple: 'Delete from Apple', google: 'Delete from Google' } as const;

/** Prominent alert for deletion batches a sync run halted until the admin decides. */
export function DeleteGuardBanner({ approvals, onApprove, onDismiss }: DeleteGuardBannerProps) {
  const { busy, error, run } = useAsyncAction();
  if (approvals.length === 0) {
    return null;
  }

  return (
    <section
      role="alert"
      aria-label="Delete Guard"
      className="mt-6 rounded-xl border-2 border-amber-400 bg-amber-50 p-6 shadow-xs"
    >
      <h2 className="text-lg font-semibold text-amber-900">Delete Guard halted a sync</h2>
      <p className="mt-1 text-sm text-amber-900">
        These deletions exceed the safety threshold and were not carried out. Review them, then approve or
        dismiss each batch.
      </p>

      <ul className="mt-4 space-y-4">
        {approvals.map((approval) => (
          <li key={approval.id} className="rounded-lg border border-amber-200 bg-white p-4">
            <h3 className="text-sm font-semibold text-slate-800">
              {approval.label}
              {` · ${approval.items.length} ${approval.items.length === 1 ? 'deletion' : 'deletions'}`}
            </h3>
            <ul className="mt-2 space-y-0.5 text-sm text-slate-700">
              {approval.items.map((item, index) => (
                <li key={`${item.uid}-${index}`}>
                  {item.summary}
                  <span className="text-xs text-slate-500">{` · ${TARGET_LABELS[item.target]}`}</span>
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={busy}
                className={warningButtonClass}
                onClick={() => void run(() => onApprove(approval.id))}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={busy}
                className={secondaryButtonClass}
                onClick={() => void run(() => onDismiss(approval.id))}
              >
                Dismiss
              </button>
            </div>
          </li>
        ))}
      </ul>

      {error && (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {error}
        </p>
      )}
    </section>
  );
}
