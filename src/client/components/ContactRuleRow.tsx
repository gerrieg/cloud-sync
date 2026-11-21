import type { ContactRuleDto, ContactRuleUpdate } from '../lib/contacts-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { DirectionSelect } from './DirectionSelect.js';

interface ContactRuleRowProps {
  rule: ContactRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: ContactRuleUpdate): void;
  onDelete(rule: ContactRuleDto): void;
}

export function ContactRuleRow({ rule, busy, onUpdate, onDelete }: ContactRuleRowProps) {
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-slate-200 p-3">
      <p className="text-sm font-medium text-slate-900">{`${rule.appleGroupName} → ${rule.googleGroupName}`}</p>
      <div className="flex flex-wrap items-end gap-3">
        <DirectionSelect
          value={rule.direction}
          readOnlyCalendar={false}
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
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => onDelete(rule)}>
          Delete rule
        </button>
      </div>
    </li>
  );
}
