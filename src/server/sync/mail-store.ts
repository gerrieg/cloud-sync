import crypto from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { mailFolderState, syncedEmails } from '../db/schema.js';

export type SyncedEmailRow = typeof syncedEmails.$inferSelect;
export type NewSyncedEmail = Omit<typeof syncedEmails.$inferInsert, 'id'>;
export type SyncedEmailPatch = Partial<Omit<NewSyncedEmail, 'profileId' | 'messageIdKey'>>;

/** Where a message sits in a synced iCloud folder. */
export interface MailLocation {
  readonly folder: string;
  readonly uid: number;
}

export function listSyncedEmails(db: AppDatabase, profileId: string): SyncedEmailRow[] {
  return db.select().from(syncedEmails).where(eq(syncedEmails.profileId, profileId)).all();
}

export function insertSyncedEmail(db: AppDatabase, values: NewSyncedEmail): void {
  db.insert(syncedEmails)
    .values({ id: crypto.randomUUID(), ...values })
    .run();
}

export function updateSyncedEmail(db: AppDatabase, id: string, patch: SyncedEmailPatch): void {
  db.update(syncedEmails).set(patch).where(eq(syncedEmails.id, id)).run();
}

export function deleteSyncedEmail(db: AppDatabase, id: string): void {
  db.delete(syncedEmails).where(eq(syncedEmails.id, id)).run();
}

export function parseLocations(row: Pick<SyncedEmailRow, 'locations'>): MailLocation[] {
  return JSON.parse(row.locations) as MailLocation[];
}

export interface MailFolderCursor {
  readonly uidValidity: number;
  readonly lastUid: number;
}

export function listMailFolderStates(db: AppDatabase, profileId: string): Map<string, MailFolderCursor> {
  const rows = db.select().from(mailFolderState).where(eq(mailFolderState.profileId, profileId)).all();
  return new Map(rows.map((row) => [row.folderPath, { uidValidity: row.uidValidity, lastUid: row.lastUid }]));
}

export function setMailFolderState(db: AppDatabase, profileId: string, folderPath: string, cursor: MailFolderCursor): void {
  db.insert(mailFolderState)
    .values({ profileId, folderPath, ...cursor })
    .onConflictDoUpdate({ target: [mailFolderState.profileId, mailFolderState.folderPath], set: cursor })
    .run();
}

export function deleteMailFolderState(db: AppDatabase, profileId: string, folderPath: string): void {
  db.delete(mailFolderState)
    .where(and(eq(mailFolderState.profileId, profileId), eq(mailFolderState.folderPath, folderPath)))
    .run();
}
