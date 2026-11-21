import { useEffect, useState } from 'react';
import {
  runContactDryRun,
  runContactSync,
  type ContactRuleDto,
  type ContactRunResult,
} from '../lib/contacts-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import { useContactRules } from '../lib/use-contact-rules.js';
import { AddContactRuleForm } from './AddContactRuleForm.js';
import { ContactRuleRow } from './ContactRuleRow.js';
import { ContactSyncResults } from './ContactSyncResults.js';
import { DeleteRuleDialog } from './DeleteRuleDialog.js';

interface ContactSyncPanelProps {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
}

/** The calendar panel already tells an unconnected Profile to connect both accounts. */
export function ContactSyncPanel({ profile, onSynced }: ContactSyncPanelProps) {
  if (!profile.appleConnected || !profile.googleConnected) {
    return null;
  }
  return <ConnectedContactSync profile={profile} onSynced={onSynced} />;
}

function ConnectedContactSync({ profile, onSynced }: ContactSyncPanelProps) {
  const { rules, discovery, loadError, add, update, remove } = useContactRules(profile.id);
  const [result, setResult] = useState<{ value: ContactRunResult; dryRun: boolean } | null>(null);
  const [deleting, setDeleting] = useState<ContactRuleDto | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setResult(null);
    setDeleting(null);
    reset();
  }, [profile.id, reset]);

  async function syncNow(force: boolean) {
    setResult({ value: await runContactSync(profile.id, force), dryRun: false });
    await onSynced();
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">Contact sync</h2>
      <p className="mt-1 text-sm text-slate-600">
        Rules pair an Apple contact group (or All Contacts) with a Google label. A contact in several groups
        exists once in Google and carries all of their labels.
      </p>

      {rules.length > 0 && (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <ContactRuleRow
              key={rule.id}
              rule={rule}
              busy={busy}
              onUpdate={(ruleId, patch) => void run(() => update(ruleId, patch))}
              onDelete={setDeleting}
            />
          ))}
        </ul>
      )}

      {discovery && <AddContactRuleForm discovery={discovery} busy={busy} onAdd={(rule) => void run(() => add(rule))} />}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setResult({ value: await runContactDryRun(profile.id), dryRun: true }))}
        >
          Preview contacts (Dry-Run)
        </button>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void run(() => syncNow(false))}>
          Sync contacts now
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          title="Pushes every Apple contact again, undoing manual changes made in Google"
          onClick={() => void run(() => syncNow(true))}
        >
          Resync all contacts (force)
        </button>
      </div>

      {(error ?? loadError) && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error ?? loadError}
        </p>
      )}
      {result && <ContactSyncResults result={result.value} dryRun={result.dryRun} />}

      {deleting && (
        <DeleteRuleDialog
          title="Delete contact rule"
          ruleLabel={`${deleting.appleGroupName} → ${deleting.googleGroupName}`}
          items="contacts"
          cleanupLabel="Also remove the synced contacts from Google"
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
