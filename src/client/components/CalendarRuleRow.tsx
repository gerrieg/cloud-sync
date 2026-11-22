import type { CalendarRuleDto, CalendarRuleUpdate } from '../lib/calendar-api.js';
import { checkboxLabelClass, controlRowClass, secondaryButtonClass } from '../lib/styles.js';
import { BidirectionalHint, DirectionSelect } from './DirectionSelect.js';
import { WindowSelect } from './WindowSelect.js';

interface CalendarRuleRowProps {
  rule: CalendarRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: CalendarRuleUpdate): void;
  onDelete(rule: CalendarRuleDto): void;
}

export function CalendarRuleRow({ rule, busy, onUpdate, onDelete }: CalendarRuleRowProps) {
  return (
    <li className="space-y-3 rounded-lg border border-slate-200 p-4">
      <div>
        <p className="text-sm font-medium break-words text-slate-900">
          {`${rule.appleCalendarName} → ${rule.googleCalendarName}`}
        </p>
        {rule.appleReadOnly && <p className="mt-0.5 text-xs text-slate-500">Read-only calendar</p>}
      </div>
      <div className={controlRowClass}>
        <DirectionSelect
          value={rule.direction}
          readOnlyCalendar={rule.appleReadOnly}
          disabled={busy}
          onChange={(direction) => onUpdate(rule.id, { direction })}
        />
        <WindowSelect
          value={rule.syncWindowDays}
          disabled={busy}
          onChange={(syncWindowDays) => onUpdate(rule.id, { syncWindowDays })}
        />
        <label className={checkboxLabelClass}>
          <input
            type="checkbox"
            checked={rule.enabled}
            disabled={busy}
            onChange={(event) => onUpdate(rule.id, { enabled: event.target.checked })}
          />
          Active
        </label>
        <label className={checkboxLabelClass}>
          <input
            type="checkbox"
            checked={rule.syncReminders}
            disabled={busy}
            onChange={(event) => onUpdate(rule.id, { syncReminders: event.target.checked })}
          />
          Sync reminders
        </label>
        <button type="button" disabled={busy} className={`${secondaryButtonClass} sm:ml-auto`} onClick={() => onDelete(rule)}>
          Delete rule
        </button>
      </div>
      <BidirectionalHint direction={rule.appleReadOnly ? 'one_way' : rule.direction} />
    </li>
  );
}
