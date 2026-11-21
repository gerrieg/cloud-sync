import { useEffect, useState } from 'react';
import {
  runMailDryRun,
  runMailSync,
  type MailRuleDto,
  type MailRunResult,
} from '../lib/mail-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { useMailRules } from '../lib/use-mail-rules.js';
import { AddMailRuleForm } from './AddMailRuleForm.js';
import { MailRuleRow } from './MailRuleRow.js';
import { MailSyncResults } from './MailSyncResults.js';
import { DeleteRuleDialog } from './DeleteRuleDialog.js';

interface MailSyncPanelProps {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
}

/** The calendar panel already tells an unconnected Profile to connect both accounts. */
export function MailSyncPanel({ profile, onSynced }: MailSyncPanelProps) {
  if (!profile.appleConnected || !profile.googleConnected) {
    return null;
  }
  return <ConnectedMailSync profile={profile} onSynced={onSynced} />;
}

function ConnectedMailSync({ profile, onSynced }: MailSyncPanelProps) {
  const { rules, discovery, loadError, add, update, remove } = useMailRules(profile.id);
  const [result, setResult] = useState<{ value: MailRunResult; dryRun: boolean } | null>(null);
  const [deleting, setDeleting] = useState<MailRuleDto | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setResult(null);
    setDeleting(null);
    reset();
  }, [profile.id, reset]);

  async function syncNow(force: boolean) {
    setResult({ value: await runMailSync(profile.id, force), dryRun: false });
    await onSynced();
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Mail sync</h2>
      <p className="mt-1 text-sm text-slate-600">
        Rules copy the emails of an iCloud folder into Gmail under a matching label (iCloud → Gmail only). A
        message in several folders exists once in Gmail and carries all of their labels.
      </p>

      {rules.length > 0 && (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <MailRuleRow
              key={rule.id}
              rule={rule}
              busy={busy}
              onUpdate={(ruleId, patch) => void run(() => update(ruleId, patch))}
              onDelete={setDeleting}
            />
          ))}
        </ul>
      )}

      {discovery && <AddMailRuleForm discovery={discovery} busy={busy} onAdd={(rule) => void run(() => add(rule))} />}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setResult({ value: await runMailDryRun(profile.id), dryRun: true }))}
        >
          Preview mail (Dry-Run)
        </button>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void run(() => syncNow(false))}>
          Sync mail now
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          title="Pushes the iCloud labels and flags of every message again, undoing manual changes made in Gmail"
          onClick={() => void run(() => syncNow(true))}
        >
          Resync all mail (force)
        </button>
      </div>

      {(error ?? loadError) && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error ?? loadError}
        </p>
      )}
      {result && <MailSyncResults result={result.value} dryRun={result.dryRun} />}

      {deleting && (
        <DeleteRuleDialog
          title="Delete mail rule"
          ruleLabel={`${deleting.appleFolderName} → ${deleting.googleLabel}`}
          items="emails"
          cleanupLabel="Also remove the synced emails from Gmail"
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={(cleanupGoogle) =>
            void run(async () => {
              await remove(deleting.id, cleanupGoogle);
              setDeleting(null);
            })
          }
        />
      )}
    </section>
  );
}
