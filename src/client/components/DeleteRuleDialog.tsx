import { useState } from 'react';
import type { CalendarRuleDto } from '../lib/calendar-api.js';
import { secondaryButtonClass } from '../lib/styles.js';

interface DeleteRuleDialogProps {
  rule: CalendarRuleDto;
  busy: boolean;
  onConfirm(cleanupGoogle: boolean): void;
  onCancel(): void;
}

/** Deleting a rule keeps the synced Google events unless the admin explicitly opts in to cleanup. */
export function DeleteRuleDialog({ rule, busy, onConfirm, onCancel }: DeleteRuleDialogProps) {
  const [cleanupGoogle, setCleanupGoogle] = useState(false);

  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-slate-900/40 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="delete-rule-title"
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-lg"
      >
        <h3 id="delete-rule-title" className="text-lg font-semibold text-slate-900">
          Delete calendar rule
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          {`${rule.appleCalendarName} → ${rule.googleCalendarName}`} will no longer be synced. The events
          already in Google stay untouched unless you tick the option below.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cleanupGoogle}
            onChange={(event) => setCleanupGoogle(event.target.checked)}
          />
          Also remove the synced events from Google
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            onClick={() => onConfirm(cleanupGoogle)}
          >
            Confirm delete
          </button>
        </div>
      </div>
    </div>
  );
}
