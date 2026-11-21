import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { syncedEvents } from '../db/schema.js';

export type SyncedEventRow = typeof syncedEvents.$inferSelect;
export type NewSyncedEvent = Omit<typeof syncedEvents.$inferInsert, 'id'>;
export type SyncedEventPatch = Partial<Omit<NewSyncedEvent, 'ruleId' | 'appleHref'>>;

export function listSyncedEvents(db: AppDatabase, ruleId: string): SyncedEventRow[] {
  return db.select().from(syncedEvents).where(eq(syncedEvents.ruleId, ruleId)).all();
}

export function insertSyncedEvent(db: AppDatabase, values: NewSyncedEvent): string {
  const id = crypto.randomUUID();
  db.insert(syncedEvents)
    .values({ id, ...values })
    .run();
  return id;
}

export function updateSyncedEvent(db: AppDatabase, id: string, patch: SyncedEventPatch): void {
  db.update(syncedEvents).set(patch).where(eq(syncedEvents.id, id)).run();
}

export function deleteSyncedEvent(db: AppDatabase, id: string): void {
  db.delete(syncedEvents).where(eq(syncedEvents.id, id)).run();
}
