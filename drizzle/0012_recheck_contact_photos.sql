-- Photos that iCloud links (PHOTO;VALUE=uri) were never synced. An unchanged address book ctag ends a
-- One-Way contact run before any card is read, so the photos of already linked contacts would never be
-- picked up. Forget the ctag once: the next run reads the address book and uploads the missing photos.
UPDATE `contact_sync_state` SET `apple_ctag` = NULL;
