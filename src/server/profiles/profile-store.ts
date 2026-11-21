import crypto from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db/index.js';
import { profiles } from '../db/schema.js';
import { decryptSecret, encryptSecret } from '../crypto/secrets.js';
import type { GoogleTokens, SyncProvidersContext } from '../providers/types.js';

export type ProfileRow = typeof profiles.$inferSelect;

/** API representation of a Profile. Never contains secrets or their ciphertext. */
export interface ProfileDto {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly appleId: string | null;
  readonly appleConnected: boolean;
  readonly googleConnected: boolean;
  readonly googleReauthRequired: boolean;
  readonly lastSyncAt: number | null;
  readonly lastSyncStatus: string | null;
}

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

export type ProfilePatch = Partial<
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

export function updateProfile(db: AppDatabase, id: string, patch: ProfilePatch): ProfileRow | undefined {
  if (Object.keys(patch).length === 0) {
    return findProfile(db, id);
  }
  return db.update(profiles).set(patch).where(eq(profiles.id, id)).returning().get();
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
