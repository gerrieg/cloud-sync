import { contactRulesApi, runContactDryRun, runContactSync } from '../lib/contacts-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { AddContactRuleForm } from './AddContactRuleForm.js';
import { ContactRuleRow } from './ContactRuleRow.js';
import { ContactSyncResults } from './ContactSyncResults.js';
import { RuleSyncPanel } from './RuleSyncPanel.js';

interface ContactSyncPanelProps {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
}

export function ContactSyncPanel({ profile, onSynced }: ContactSyncPanelProps) {
  return (
    <RuleSyncPanel
      profile={profile}
      onSynced={onSynced}
      rulesApi={contactRulesApi}
      loadErrorMessage="Could not load contact groups"
      runDryRun={runContactDryRun}
      runSync={runContactSync}
      title="Contact sync"
      description="Rules pair an Apple contact group (or All Contacts) with a Google label. A contact in several groups exists once in Google and carries all of their labels."
      labels={{
        preview: 'Preview contacts (Dry-Run)',
        sync: 'Sync contacts now',
        force: 'Resync all contacts (force)',
        forceHint: 'Pushes every Apple contact again, undoing manual changes made in Google',
      }}
      deleteDialog={{
        title: 'Delete contact rule',
        items: 'contacts',
        cleanupLabel: 'Also remove the synced contacts from Google',
        ruleLabel: (rule) => `${rule.appleGroupName} → ${rule.googleGroupName}`,
      }}
      renderRule={(rule, busy, onUpdate, onDelete) => (
        <ContactRuleRow rule={rule} busy={busy} onUpdate={onUpdate} onDelete={onDelete} />
      )}
      renderAddForm={(discovery, busy, onAdd) => <AddContactRuleForm discovery={discovery} busy={busy} onAdd={onAdd} />}
      renderResult={(result, dryRun) => <ContactSyncResults result={result} dryRun={dryRun} />}
    />
  );
}
