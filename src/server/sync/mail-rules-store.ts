import crypto from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { MailRuleDto } from '../../shared/mail.js';
import type { AppDatabase } from '../db/index.js';
import { mailSyncRules } from '../db/schema.js';

export type MailRuleRow = typeof mailSyncRules.$inferSelect;
export type NewMailRule = Omit<typeof mailSyncRules.$inferInsert, 'id'>;
export type MailRulePatch = Partial<Pick<MailRuleRow, 'syncWindowDays' | 'deleteBehavior' | 'enabled'>>;

export function toMailRuleDto(row: MailRuleRow): MailRuleDto {
  return {
    id: row.id,
    appleFolderPath: row.appleFolderPath,
    appleFolderName: row.appleFolderName,
    googleLabel: row.googleLabel,
    syncWindowDays: row.syncWindowDays,
    deleteBehavior: row.deleteBehavior,
    enabled: row.enabled,
  };
}

export function listMailRules(db: AppDatabase, profileId: string): MailRuleRow[] {
  return db.select().from(mailSyncRules).where(eq(mailSyncRules.profileId, profileId)).orderBy(sql`rowid`).all();
}

export function findMailRule(db: AppDatabase, profileId: string, ruleId: string): MailRuleRow | undefined {
  return db
    .select()
    .from(mailSyncRules)
    .where(and(eq(mailSyncRules.profileId, profileId), eq(mailSyncRules.id, ruleId)))
    .get();
}

export function findMailRuleByFolder(db: AppDatabase, profileId: string, folderPath: string): MailRuleRow | undefined {
  return db
    .select()
    .from(mailSyncRules)
    .where(and(eq(mailSyncRules.profileId, profileId), eq(mailSyncRules.appleFolderPath, folderPath)))
    .get();
}

export function insertMailRule(db: AppDatabase, values: NewMailRule): MailRuleRow {
  return db
    .insert(mailSyncRules)
    .values({ id: crypto.randomUUID(), ...values })
    .returning()
    .get();
}

/** Applies a patch to an existing rule; throws if the rule does not exist. */
export function updateMailRule(db: AppDatabase, ruleId: string, patch: MailRulePatch): MailRuleRow {
  const row = db.update(mailSyncRules).set(patch).where(eq(mailSyncRules.id, ruleId)).returning().get();
  if (!row) {
    throw new Error(`Mail rule ${ruleId} not found`);
  }
  return row;
}

export function deleteMailRule(db: AppDatabase, ruleId: string): void {
  db.delete(mailSyncRules).where(eq(mailSyncRules.id, ruleId)).run();
}
