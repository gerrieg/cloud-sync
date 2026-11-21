interface WindowSelectProps {
  /** Days of history to sync; null means all history. */
  value: number | null;
  disabled?: boolean;
  onChange(value: number | null): void;
}

export function WindowSelect({ value, disabled, onChange }: WindowSelectProps) {
  return (
    <label className="text-sm text-slate-700">
      History window
      <select
        value={value === null ? 'all' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === 'all' ? null : Number(event.target.value))}
        className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
      >
        <option value="30">Last 30 days</option>
        {value !== null && value !== 30 && <option value={String(value)}>Last {value} days</option>}
        <option value="all">All history</option>
      </select>
    </label>
  );
}
