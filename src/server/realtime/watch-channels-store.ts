import { eq } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { googleWatchChannels } from '../db/schema.js';

export type WatchChannelRow = typeof googleWatchChannels.$inferSelect;

export function listWatchChannels(db: AppDatabase, profileId: string): WatchChannelRow[] {
  return db.select().from(googleWatchChannels).where(eq(googleWatchChannels.profileId, profileId)).all();
}

export function findWatchChannel(db: AppDatabase, channelId: string): WatchChannelRow | undefined {
  return db.select().from(googleWatchChannels).where(eq(googleWatchChannels.id, channelId)).get();
}

export function insertWatchChannel(db: AppDatabase, row: WatchChannelRow): void {
  db.insert(googleWatchChannels).values(row).run();
}

export function deleteWatchChannel(db: AppDatabase, channelId: string): void {
  db.delete(googleWatchChannels).where(eq(googleWatchChannels.id, channelId)).run();
}
