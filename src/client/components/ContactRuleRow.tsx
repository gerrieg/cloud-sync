import type { ContactRuleDto, ContactRuleUpdate } from '../lib/contacts-api.js';
import { checkboxLabelClass, controlRowClass, secondaryButtonClass } from '../lib/styles.js';
import { BidirectionalHint, DirectionSelect } from './DirectionSelect.js';

interface ContactRuleRowProps {
  rule: ContactRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: ContactRuleUpdate): void;
  onDelete(rule: ContactRuleDto): void;
}

export function ContactRuleRow({ rule, busy, onUpdate, onDelete }: ContactRuleRowProps) {
  return (
    <li className="space-y-3 rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium break-words text-slate-900">{`${rule.appleGroupName} → ${rule.googleGroupName}`}</p>
      <div className={controlRowClass}>
        <DirectionSelect
          value={rule.direction}
          readOnlyCalendar={false}
          disabled={busy}
          onChange={(direction) => onUpdate(rule.id, { direction })}
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
        <button type="button" disabled={busy} className={`${secondaryButtonClass} sm:ml-auto`} onClick={() => onDelete(rule)}>
          Delete rule
        </button>
      </div>
      <BidirectionalHint direction={rule.direction} />
    </li>
  );
}
