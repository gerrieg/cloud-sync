import { mailRulesApi, runMailDryRun, runMailSync } from '../lib/mail-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { AddMailRuleForm } from './AddMailRuleForm.js';
import { MailRuleRow } from './MailRuleRow.js';
import { MailSyncResults } from './MailSyncResults.js';
import { RuleSyncPanel } from './RuleSyncPanel.js';

interface MailSyncPanelProps {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
}

export function MailSyncPanel({ profile, onSynced }: MailSyncPanelProps) {
  return (
    <RuleSyncPanel
      profile={profile}
      onSynced={onSynced}
      rulesApi={mailRulesApi}
      loadErrorMessage="Could not load mail folders"
      runDryRun={runMailDryRun}
      runSync={runMailSync}
      title="Mail sync"
      description="Rules copy the emails of an iCloud folder into Gmail under a matching label (iCloud → Gmail only). A message in several folders exists once in Gmail and carries all of their labels."
      labels={{
        preview: 'Preview mail (Dry-Run)',
        sync: 'Sync mail now',
        force: 'Resync all mail (force)',
        forceHint: 'Pushes the iCloud labels and flags of every message again, undoing manual changes made in Gmail',
      }}
      deleteDialog={{
        title: 'Delete mail rule',
        items: 'emails',
        cleanupLabel: 'Also remove the synced emails from Gmail',
        ruleLabel: (rule) => `${rule.appleFolderName} → ${rule.googleLabel}`,
      }}
      renderRule={(rule, busy, onUpdate, onDelete) => (
        <MailRuleRow rule={rule} busy={busy} onUpdate={onUpdate} onDelete={onDelete} />
      )}
      renderAddForm={(discovery, busy, onAdd) => <AddMailRuleForm discovery={discovery} busy={busy} onAdd={onAdd} />}
      renderResult={(result, dryRun) => <MailSyncResults result={result} dryRun={dryRun} />}
    />
  );
}
