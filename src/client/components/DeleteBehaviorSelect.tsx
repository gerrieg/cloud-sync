import type { MailDeleteBehavior } from '../../shared/mail.js';
import { selectClass } from '../lib/styles.js';

interface DeleteBehaviorSelectProps {
  value: MailDeleteBehavior;
  disabled?: boolean;
  onChange(value: MailDeleteBehavior): void;
}

export function DeleteBehaviorSelect({ value, disabled, onChange }: DeleteBehaviorSelectProps) {
  return (
    <label className="text-sm text-slate-700">
      When deleted in iCloud
      <select
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as MailDeleteBehavior)}
        className={selectClass}
      >
        <option value="trash">Move to Gmail Trash</option>
        <option value="delete">Delete permanently</option>
      </select>
    </label>
  );
}
