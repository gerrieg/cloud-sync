import { useState, type FormEvent } from 'react';
import type { MailDeleteBehavior } from '../../shared/mail.js';
import type { MailFolderDiscovery, MailRuleCreate } from '../lib/mail-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { DeleteBehaviorSelect } from './DeleteBehaviorSelect.js';
import { WindowSelect } from './WindowSelect.js';

interface AddMailRuleFormProps {
  discovery: MailFolderDiscovery;
  busy: boolean;
  onAdd(rule: MailRuleCreate): void;
}

export function AddMailRuleForm({ discovery, busy, onAdd }: AddMailRuleFormProps) {
  const [path, setPath] = useState(discovery.folders[0]?.path ?? '');
  const [syncWindowDays, setSyncWindowDays] = useState<number | null>(30);
  const [deleteBehavior, setDeleteBehavior] = useState<MailDeleteBehavior>('trash');

  if (discovery.folders.length === 0) {
    return <p className="mt-4 text-sm text-slate-600">No iCloud mail folders found.</p>;
  }
  const target = discovery.folders.find((folder) => folder.path === path)?.googleLabel;

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    if (path) {
      onAdd({ appleFolderPath: path, syncWindowDays, deleteBehavior });
    }
  }

  return (
    <form onSubmit={handleSubmit} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="text-sm text-slate-700">
        iCloud folder
        <select
          value={path}
          onChange={(event) => setPath(event.target.value)}
          className="mt-1 block rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm"
        >
          {discovery.folders.map((folder) => (
            <option key={folder.path} value={folder.path}>
              {folder.name}
            </option>
          ))}
        </select>
      </label>
      <p className="pb-2 text-sm text-slate-700">
        Gmail label: <span className="font-medium">{target}</span>
      </p>
      <WindowSelect label="Start date" value={syncWindowDays} onChange={setSyncWindowDays} />
      <DeleteBehaviorSelect value={deleteBehavior} onChange={setDeleteBehavior} />
      <button type="submit" disabled={busy} className={secondaryButtonClass}>
        Add mail rule
      </button>
    </form>
  );
}
