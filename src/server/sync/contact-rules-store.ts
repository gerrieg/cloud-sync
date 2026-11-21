import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { ContactRuleDto } from '../../shared/contacts.js';
import type { AppDatabase } from '../db/index.js';
import { contactSyncRules } from '../db/schema.js';

export type ContactRuleRow = typeof contactSyncRules.$inferSelect;
export type NewContactRule = Omit<typeof contactSyncRules.$inferInsert, 'id' | 'initialSyncCompletedAt'>;
export type ContactRulePatch = Partial<Pick<ContactRuleRow, 'direction' | 'enabled' | 'initialSyncCompletedAt'>>;

export function toContactRuleDto(row: ContactRuleRow): ContactRuleDto {
  return {
    id: row.id,
    appleGroupUid: row.appleGroupUid,
    appleGroupName: row.appleGroupName,
    googleGroupResourceName: row.googleGroupResourceName,
    googleGroupName: row.googleGroupName,
    direction: row.direction,
    enabled: row.enabled,
  };
}

export function listContactRules(db: AppDatabase, profileId: string): ContactRuleRow[] {
  return db
    .select()
    .from(contactSyncRules)
    .where(eq(contactSyncRules.profileId, profileId))
    .orderBy(sql`rowid`)
    .all();
}

export function findContactRule(db: AppDatabase, profileId: string, ruleId: string): ContactRuleRow | undefined {
  return db
    .select()
    .from(contactSyncRules)
    .where(and(eq(contactSyncRules.profileId, profileId), eq(contactSyncRules.id, ruleId)))
    .get();
}

export function findContactRuleByPair(
  db: AppDatabase,
  profileId: string,
  appleGroupUid: string,
  googleGroupResourceName: string,
): ContactRuleRow | undefined {
  return db
    .select()
    .from(contactSyncRules)
    .where(
      and(
        eq(contactSyncRules.profileId, profileId),
        eq(contactSyncRules.appleGroupUid, appleGroupUid),
        eq(contactSyncRules.googleGroupResourceName, googleGroupResourceName),
      ),
    )
    .get();
}

export function insertContactRule(db: AppDatabase, values: NewContactRule): ContactRuleRow {
  return db
    .insert(contactSyncRules)
    .values({ id: crypto.randomUUID(), ...values })
    .returning()
    .get();
}

/** Applies a patch to an existing rule; throws if the rule does not exist. */
export function updateContactRule(db: AppDatabase, ruleId: string, patch: ContactRulePatch): ContactRuleRow {
  const row = db.update(contactSyncRules).set(patch).where(eq(contactSyncRules.id, ruleId)).returning().get();
  if (!row) {
    throw new Error(`Contact rule ${ruleId} not found`);
  }
  return row;
}

export function deleteContactRule(db: AppDatabase, ruleId: string): void {
  db.delete(contactSyncRules).where(eq(contactSyncRules.id, ruleId)).run();
}
