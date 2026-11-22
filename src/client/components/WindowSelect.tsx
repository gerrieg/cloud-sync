import { selectClass } from '../lib/styles.js';

interface WindowSelectProps {
  /** Days of history to sync; null means all history. */
  value: number | null;
  disabled?: boolean;
  /** Defaults to `History window`. */
  label?: string;
  onChange(value: number | null): void;
}

export function WindowSelect({ value, disabled, label = 'History window', onChange }: WindowSelectProps) {
  return (
    <label className="text-sm text-slate-700">
      {label}
      <select
        value={value === null ? 'all' : String(value)}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === 'all' ? null : Number(event.target.value))}
        className={selectClass}
      >
        <option value="30">Last 30 days</option>
        {value !== null && value !== 30 && <option value={String(value)}>Last {value} days</option>}
        <option value="all">All history</option>
      </select>
    </label>
  );
}
