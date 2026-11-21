import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { CalendarRuleDto } from '../../shared/calendar.js';
import type { AppDatabase } from '../db/index.js';
import { calendarSyncRules } from '../db/schema.js';

export type RuleRow = typeof calendarSyncRules.$inferSelect;
export type NewRule = Omit<
  typeof calendarSyncRules.$inferInsert,
  'id' | 'appleCtag' | 'googleSyncToken' | 'initialSyncCompletedAt'
>;
export type RulePatch = Partial<
  Pick<
    RuleRow,
    | 'direction'
    | 'syncWindowDays'
    | 'syncReminders'
    | 'enabled'
    | 'appleCtag'
    | 'googleSyncToken'
    | 'initialSyncCompletedAt'
  >
>;

export function toRuleDto(row: RuleRow): CalendarRuleDto {
  return {
    id: row.id,
    appleCalendarUrl: row.appleCalendarUrl,
    appleCalendarName: row.appleCalendarName,
    appleReadOnly: row.appleReadOnly,
    googleCalendarId: row.googleCalendarId,
    googleCalendarName: row.googleCalendarName,
    direction: row.direction,
    syncWindowDays: row.syncWindowDays,
    syncReminders: row.syncReminders,
    enabled: row.enabled,
  };
}

export function listRules(db: AppDatabase, profileId: string): RuleRow[] {
  return db
    .select()
    .from(calendarSyncRules)
    .where(eq(calendarSyncRules.profileId, profileId))
    .orderBy(sql`rowid`)
    .all();
}

export function findRule(db: AppDatabase, profileId: string, ruleId: string): RuleRow | undefined {
  return db
    .select()
    .from(calendarSyncRules)
    .where(and(eq(calendarSyncRules.profileId, profileId), eq(calendarSyncRules.id, ruleId)))
    .get();
}

export function findRuleByPair(
  db: AppDatabase,
  profileId: string,
  appleCalendarUrl: string,
  googleCalendarId: string,
): RuleRow | undefined {
  return db
    .select()
    .from(calendarSyncRules)
    .where(
      and(
        eq(calendarSyncRules.profileId, profileId),
        eq(calendarSyncRules.appleCalendarUrl, appleCalendarUrl),
        eq(calendarSyncRules.googleCalendarId, googleCalendarId),
      ),
    )
    .get();
}

export function insertRule(db: AppDatabase, values: NewRule): RuleRow {
  return db
    .insert(calendarSyncRules)
    .values({ id: crypto.randomUUID(), ...values })
    .returning()
    .get();
}

/** Applies a patch to an existing rule; throws if the rule does not exist. */
export function updateRule(db: AppDatabase, ruleId: string, patch: RulePatch): RuleRow {
  const row = db
    .update(calendarSyncRules)
    .set(patch)
    .where(eq(calendarSyncRules.id, ruleId))
    .returning()
    .get();
  if (!row) {
    throw new Error(`Rule ${ruleId} not found`);
  }
  return row;
}

export function deleteRule(db: AppDatabase, ruleId: string): void {
  db.delete(calendarSyncRules).where(eq(calendarSyncRules.id, ruleId)).run();
}
