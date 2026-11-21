import type { MailRuleDto, MailRuleUpdate } from '../lib/mail-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { DeleteBehaviorSelect } from './DeleteBehaviorSelect.js';
import { WindowSelect } from './WindowSelect.js';

interface MailRuleRowProps {
  rule: MailRuleDto;
  busy: boolean;
  onUpdate(ruleId: string, patch: MailRuleUpdate): void;
  onDelete(rule: MailRuleDto): void;
}

export function MailRuleRow({ rule, busy, onUpdate, onDelete }: MailRuleRowProps) {
  return (
    <li className="flex flex-wrap items-end justify-between gap-3 rounded-lg border border-slate-200 p-3">
      <p className="text-sm font-medium text-slate-900">{`${rule.appleFolderName} → ${rule.googleLabel}`}</p>
      <div className="flex flex-wrap items-end gap-3">
        <WindowSelect
          label="Start date"
          value={rule.syncWindowDays}
          disabled={busy}
          onChange={(syncWindowDays) => onUpdate(rule.id, { syncWindowDays })}
        />
        <DeleteBehaviorSelect
          value={rule.deleteBehavior}
          disabled={busy}
          onChange={(deleteBehavior) => onUpdate(rule.id, { deleteBehavior })}
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
