import { calendarRulesApi, runDryRun, runSync } from '../lib/calendar-api.js';
import type { Profile } from '../lib/profiles-api.js';
import { AddCalendarRuleForm } from './AddCalendarRuleForm.js';
import { CalendarRuleRow } from './CalendarRuleRow.js';
import { RuleSyncPanel } from './RuleSyncPanel.js';
import { SyncResults } from './SyncResults.js';

interface CalendarSyncPanelProps {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
}

export function CalendarSyncPanel({ profile, onSynced }: CalendarSyncPanelProps) {
  return (
    <RuleSyncPanel
      profile={profile}
      onSynced={onSynced}
      rulesApi={calendarRulesApi}
      loadErrorMessage="Could not load calendars"
      disconnectedMessage="Connect both accounts to configure calendar sync for this Profile."
      runDryRun={runDryRun}
      runSync={runSync}
      title="Calendar sync"
      description="Rules pair an Apple calendar with a Google calendar. Preview first: a Dry-Run changes nothing."
      labels={{
        preview: 'Preview (Dry-Run)',
        sync: 'Sync Now',
        force: 'Force-Resync',
        forceHint: 'Pushes every Apple event again, undoing manual changes made in Google',
      }}
      deleteDialog={{
        title: 'Delete calendar rule',
        items: 'events',
        cleanupLabel: 'Also remove the synced events from Google',
        ruleLabel: (rule) => `${rule.appleCalendarName} → ${rule.googleCalendarName}`,
      }}
      renderRule={(rule, busy, onUpdate, onDelete) => (
        <CalendarRuleRow rule={rule} busy={busy} onUpdate={onUpdate} onDelete={onDelete} />
      )}
      renderAddForm={(discovery, busy, onAdd) => <AddCalendarRuleForm discovery={discovery} busy={busy} onAdd={onAdd} />}
      renderResult={(result, _dryRun, rules) => <SyncResults result={result} rules={[...rules]} />}
    />
  );
}
