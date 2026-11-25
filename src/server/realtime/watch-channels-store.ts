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

/** Completes a pre-registered channel once Google returns its resourceId and expiry, preserving confirmedAt. */
export function updateWatchChannel(
  db: AppDatabase,
  channelId: string,
  patch: { readonly resourceId: string; readonly expiresAt: number },
): void {
  db.update(googleWatchChannels).set(patch).where(eq(googleWatchChannels.id, channelId)).run();
}

/** Records that Google reached the webhook through this channel (keeps the first time). */
export function confirmWatchChannel(db: AppDatabase, channel: WatchChannelRow, at: number): void {
  if (channel.confirmedAt === null) {
    db.update(googleWatchChannels).set({ confirmedAt: at }).where(eq(googleWatchChannels.id, channel.id)).run();
  }
}

export function deleteWatchChannel(db: AppDatabase, channelId: string): void {
  db.delete(googleWatchChannels).where(eq(googleWatchChannels.id, channelId)).run();
}
