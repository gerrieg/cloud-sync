import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { contactSyncState, syncedContacts } from '../db/schema.js';

export type SyncedContactRow = typeof syncedContacts.$inferSelect;
export type NewSyncedContact = Omit<typeof syncedContacts.$inferInsert, 'id'>;
export type SyncedContactPatch = Partial<Omit<NewSyncedContact, 'profileId' | 'appleContactUid'>>;

export function listSyncedContacts(db: AppDatabase, profileId: string): SyncedContactRow[] {
  return db.select().from(syncedContacts).where(eq(syncedContacts.profileId, profileId)).all();
}

export function insertSyncedContact(db: AppDatabase, values: NewSyncedContact): string {
  const id = crypto.randomUUID();
  db.insert(syncedContacts)
    .values({ id, ...values })
    .run();
  return id;
}

export function updateSyncedContact(db: AppDatabase, id: string, patch: SyncedContactPatch): void {
  db.update(syncedContacts).set(patch).where(eq(syncedContacts.id, id)).run();
}

export function deleteSyncedContact(db: AppDatabase, id: string): void {
  db.delete(syncedContacts).where(eq(syncedContacts.id, id)).run();
}

export function parseLabels(row: Pick<SyncedContactRow, 'labels'>): string[] {
  return JSON.parse(row.labels) as string[];
}

export interface ContactCursor {
  readonly appleCtag: string | null;
  readonly googleSyncToken: string | null;
}

export function getContactCursor(db: AppDatabase, profileId: string): ContactCursor {
  const row = db.select().from(contactSyncState).where(eq(contactSyncState.profileId, profileId)).get();
  return { appleCtag: row?.appleCtag ?? null, googleSyncToken: row?.googleSyncToken ?? null };
}

export function setContactCursor(db: AppDatabase, profileId: string, patch: Partial<ContactCursor>): void {
  db.insert(contactSyncState)
    .values({ profileId, ...patch })
    .onConflictDoUpdate({ target: contactSyncState.profileId, set: patch })
    .run();
}
