import { useState } from 'react';
import { dangerButtonClass, secondaryButtonClass } from '../lib/styles.js';

interface DeleteRuleDialogProps {
  /** e.g. `Delete calendar rule`. */
  title: string;
  /** Names the rule, e.g. `Privat → Anna`. */
  ruleLabel: string;
  /** What stays in Google, e.g. `events`. */
  items: string;
  /** Label of the cleanup opt-in checkbox. */
  cleanupLabel: string;
  busy: boolean;
  onConfirm(cleanupGoogle: boolean): void;
  onCancel(): void;
}

/** Deleting a rule keeps the synced Google events unless the admin explicitly opts in to cleanup. */
export function DeleteRuleDialog({ title, ruleLabel, items, cleanupLabel, busy, onConfirm, onCancel }: DeleteRuleDialogProps) {
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
          {title}
        </h3>
        <p className="mt-2 text-sm text-slate-600">
          {ruleLabel} will no longer be synced. The {items} already in Google stay untouched unless you tick
          the option below.
        </p>
        <label className="mt-4 flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            className="mt-0.5"
            checked={cleanupGoogle}
            onChange={(event) => setCleanupGoogle(event.target.checked)}
          />
          {cleanupLabel}
        </label>
        <div className="mt-6 flex justify-end gap-2">
          <button type="button" className={secondaryButtonClass} onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            disabled={busy}
            className={dangerButtonClass}
            onClick={() => onConfirm(cleanupGoogle)}
          >
            Confirm delete
          </button>
        </div>
      </div>
    </div>
  );
}
