import type { MailRuleDto, MailRuleUpdate } from '../lib/mail-api.js';
import { checkboxLabelClass, controlRowClass, secondaryButtonClass } from '../lib/styles.js';
import { WindowSelect } from './WindowSelect.js';

interface MailRuleRowProps {
  rule: MailRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: MailRuleUpdate): void;
  onDelete(rule: MailRuleDto): void;
}

export function MailRuleRow({ rule, busy, onUpdate, onDelete }: MailRuleRowProps) {
  return (
    <li className="space-y-3 rounded-lg border border-slate-200 p-4">
      <p className="text-sm font-medium break-words text-slate-900">{`${rule.appleFolderName} → ${rule.googleLabel}`}</p>
      <div className={controlRowClass}>
        <WindowSelect
          label="Start date"
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
        <button type="button" disabled={busy} className={`${secondaryButtonClass} sm:ml-auto`} onClick={() => onDelete(rule)}>
          Delete rule
        </button>
      </div>
    </li>
  );
}
