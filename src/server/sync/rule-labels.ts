import type { AppDatabase } from '../db/index.js';
import { calendarSyncRules, contactSyncRules, mailSyncRules } from '../db/schema.js';

type CalendarRule = typeof calendarSyncRules.$inferSelect;
type ContactRule = typeof contactSyncRules.$inferSelect;
type MailRule = typeof mailSyncRules.$inferSelect;

/** How a Sync Rule is named for people: Apple side → Google side, e.g. `Privat → Anna`. */
export const calendarRuleLabel = (rule: CalendarRule) => `${rule.appleCalendarName} → ${rule.googleCalendarName}`;
export const contactRuleLabel = (rule: ContactRule) => `${rule.appleGroupName} → ${rule.googleGroupName}`;
export const mailRuleLabel = (rule: MailRule) => `${rule.appleFolderName} → ${rule.googleLabel}`;

/** Display names of every Sync Rule (calendar, contact and mail) by rule id. */
export function loadRuleLabels(db: AppDatabase): Map<string, string> {
  const labels = new Map<string, string>();
  for (const rule of db.select().from(calendarSyncRules).all()) {
    labels.set(rule.id, calendarRuleLabel(rule));
  }
  for (const rule of db.select().from(contactSyncRules).all()) {
    labels.set(rule.id, contactRuleLabel(rule));
  }
  for (const rule of db.select().from(mailSyncRules).all()) {
    labels.set(rule.id, mailRuleLabel(rule));
  }
  return labels;
}
