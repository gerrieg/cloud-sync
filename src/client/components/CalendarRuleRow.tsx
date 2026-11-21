import type { CalendarRuleDto, CalendarRuleUpdate } from '../lib/calendar-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { DirectionSelect } from './DirectionSelect.js';
import { WindowSelect } from './WindowSelect.js';

interface CalendarRuleRowProps {
  rule: CalendarRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: CalendarRuleUpdate): void;
  onDelete(rule: CalendarRuleDto): void;
}

export function CalendarRuleRow({ rule, busy, onUpdate, onDelete }: CalendarRuleRowProps) {
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-slate-200 p-3">
      <div>
        <p className="text-sm font-medium text-slate-900">
          {`${rule.appleCalendarName} → ${rule.googleCalendarName}`}
        </p>
        {rule.appleReadOnly && <p className="text-xs text-slate-500">Read-only calendar</p>}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <DirectionSelect
          value={rule.direction}
          readOnlyCalendar={rule.appleReadOnly}
          disabled={busy}
          onChange={(direction) => onUpdate(rule.id, { direction })}
        />
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={busy}
            onChange={(event) => onUpdate(rule.id, { enabled: event.target.checked })}
          />
          Active
        </label>
        <WindowSelect
          value={rule.syncWindowDays}
          disabled={busy}
          onChange={(syncWindowDays) => onUpdate(rule.id, { syncWindowDays })}
        />
        <label className="flex items-center gap-2 pb-2 text-sm text-slate-700">
          <input
            type="checkbox"
            checked={rule.syncReminders}
            disabled={busy}
            onChange={(event) => onUpdate(rule.id, { syncReminders: event.target.checked })}
          />
          Sync reminders
        </label>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => onDelete(rule)}>
          Delete rule
        </button>
      </div>
    </li>
  );
}
