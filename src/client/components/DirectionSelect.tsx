import type { SyncDirection } from '../../shared/calendar.js';
import { selectClass } from '../lib/styles.js';

interface DirectionSelectProps {
  value: SyncDirection;
  /** Read-only and subscribed Apple calendars can only ever sync Apple → Google. */
  readOnlyCalendar: boolean;
  disabled?: boolean;
  onChange(direction: SyncDirection): void;
}

export function DirectionSelect({ value, readOnlyCalendar, disabled, onChange }: DirectionSelectProps) {
  const effective = readOnlyCalendar ? 'one_way' : value;
  return (
    <label className="text-sm text-slate-700">
      Direction
      <select
        value={effective}
        disabled={disabled || readOnlyCalendar}
        onChange={(event) => onChange(event.target.value as SyncDirection)}
        className={selectClass}
      >
        <option value="one_way">Apple → Google</option>
        <option value="bidirectional">Bidirectional (Apple wins)</option>
      </select>
    </label>
  );
}

/** Explains Apple Master; shown on its own line under a row of controls so it never shifts them. */
export function BidirectionalHint({ direction }: { direction: SyncDirection }) {
  if (direction !== 'bidirectional') {
    return null;
  }
  return (
    <p className="text-xs text-slate-500">
      Uncontested Google edits and deletions are carried over to Apple; if both sides changed, Apple wins.
    </p>
  );
}
