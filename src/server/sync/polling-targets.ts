import { isActive, type ProfileRow } from '../profiles/profile-store.js';
import type { AppDatabase } from '../db/index.js';
import { isBidirectional } from './calendar-sync.js';
import { listContactRules } from './contact-rules-store.js';
import { listMailRules } from './mail-rules-store.js';
import { listRules } from './rules-store.js';

/** What the enabled Sync Rules of an active Profile make worth watching for changes. */
export interface PollingTargets {
  /** The Apple mail folders to poll; the INBOX of a Profile with any of them also gets an IDLE connection. */
  readonly appleMailFolders: readonly string[];
  readonly appleCalendarUrls: readonly string[];
  /** Google calendars whose changes must reach Apple: the ones of bidirectional rules. */
  readonly watchedGoogleCalendarIds: readonly string[];
  readonly hasContactRules: boolean;
}

/** Nothing for a Profile that is paused or not fully connected. */
export function pollingTargetsOf(db: AppDatabase, profile: ProfileRow): PollingTargets {
  if (!isActive(profile)) {
    return { appleMailFolders: [], appleCalendarUrls: [], watchedGoogleCalendarIds: [], hasContactRules: false };
  }
  const calendarRules = listRules(db, profile.id).filter((rule) => rule.enabled);
  return {
    appleMailFolders: [
      ...new Set(
        listMailRules(db, profile.id)
          .filter((rule) => rule.enabled)
          .map((rule) => rule.appleFolderPath),
      ),
    ],
    appleCalendarUrls: calendarRules.map((rule) => rule.appleCalendarUrl),
    watchedGoogleCalendarIds: [
      ...new Set(calendarRules.filter(isBidirectional).map((rule) => rule.googleCalendarId)),
    ],
    hasContactRules: listContactRules(db, profile.id).some((rule) => rule.enabled),
  };
}
