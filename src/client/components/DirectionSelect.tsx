import type { SyncDirection } from '../../shared/calendar.js';

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
    <div>
      <label className="text-sm text-slate-700">
        Direction
        <select
          value={effective}
          disabled={disabled || readOnlyCalendar}
          onChange={(event) => onChange(event.target.value as SyncDirection)}
          className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm disabled:opacity-60"
        >
          <option value="one_way">Apple → Google</option>
          <option value="bidirectional">Bidirectional (Apple wins)</option>
        </select>
      </label>
      {effective === 'bidirectional' && (
        <p className="mt-1 max-w-56 text-xs text-slate-500">
          Uncontested Google edits and deletions are carried over to Apple; if both sides changed, Apple wins.
        </p>
      )}
    </div>
  );
}
