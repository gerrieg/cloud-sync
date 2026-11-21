import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { profiles } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { ProfileDto } from '../../shared/profile.js';
import type { GoogleTokens, SyncProvidersContext } from '../providers/types.js';

export type ProfileRow = typeof profiles.$inferSelect;

export function toProfileDto(row: ProfileRow): ProfileDto {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    appleId: row.appleId,
    appleConnected: row.appleId !== null && row.appleAppPasswordEnc !== null,
    googleConnected: row.googleTokensEnc !== null,
    googleReauthRequired: row.googleReauthRequired,
    lastSyncAt: row.lastSyncAt,
    lastSyncStatus: row.lastSyncStatus,
  };
}

export function generateTriggerToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function listProfiles(db: AppDatabase): ProfileRow[] {
  return db.select().from(profiles).orderBy(sql`rowid`).all();
}

export function findProfile(db: AppDatabase, id: string): ProfileRow | undefined {
  return db.select().from(profiles).where(eq(profiles.id, id)).get();
}

export function insertProfile(db: AppDatabase, name: string, encryptionKey: Buffer): ProfileRow {
  return db
    .insert(profiles)
    .values({
      id: crypto.randomUUID(),
      name,
      triggerTokenEnc: encryptSecret(generateTriggerToken(), encryptionKey),
    })
    .returning()
    .get();
}

export type ProfileRowPatch = Partial<
  Pick<
    ProfileRow,
    | 'name'
    | 'enabled'
    | 'appleId'
    | 'appleAppPasswordEnc'
    | 'googleTokensEnc'
    | 'googleReauthRequired'
    | 'triggerTokenEnc'
  >
>;

/** Applies a patch to an existing Profile; throws if the Profile does not exist. */
export function updateProfile(db: AppDatabase, id: string, patch: ProfileRowPatch): ProfileRow {
  const row =
    Object.keys(patch).length === 0
      ? findProfile(db, id)
      : db.update(profiles).set(patch).where(eq(profiles.id, id)).returning().get();
  if (!row) {
    throw new Error(`Profile ${id} not found`);
  }
  return row;
}

export function deleteProfile(db: AppDatabase, id: string): boolean {
  return db.delete(profiles).where(eq(profiles.id, id)).returning({ id: profiles.id }).all().length > 0;
}

/** Decrypts a Profile's stored credentials for handing to its (per-Profile) SyncProviders. */
export function toProvidersContext(row: ProfileRow, encryptionKey: Buffer): SyncProvidersContext {
  return {
    profileId: row.id,
    apple:
      row.appleId !== null && row.appleAppPasswordEnc !== null
        ? { appleId: row.appleId, appPassword: decryptSecret(row.appleAppPasswordEnc, encryptionKey) }
        : null,
    googleTokens:
      row.googleTokensEnc !== null
        ? (JSON.parse(decryptSecret(row.googleTokensEnc, encryptionKey)) as GoogleTokens)
        : null,
  };
}
