---
status: accepted
---

# Apple-Master Sync Semantics, Delete Guard, and Profile-Wide Deduplication

Sync behavior follows four deliberate rules: (1) Initial Sync matches pre-existing Google records by stable keys and never silently deletes unmatched Google data (leaving it untouched in One-Way Sync and importing it to Apple in bidirectional mode); (2) One-Way Sync is strictly change-driven and ignores manual edits or deletions on Google until Apple changes again; (3) Bidirectional sync uses Apple Master for concurrent conflicts while propagating uncontested Google deletions back to Apple, gated by a Delete Guard that halts runs exceeding a deletion count or percentage threshold until an admin confirms; and (4) Synced Items for contacts and emails are deduplicated profile-wide across Sync Rules (so removing an Apple contact from a synced group only removes the corresponding Google label rather than deleting the contact), whereas calendar events remain scoped per Sync Rule.

## Considered Options

- **No-delete-back from Google to Apple**: Rejected because intentional cleanup in Google Calendar or Contacts would silently revert or leave orphans, violating user expectations of bidirectional sync.
- **Strict mirroring in One-Way Sync**: Rejected because polling Google to undo manual changes (such as reading or archiving synced Gmail messages) wastes API quota and produces surprising regressions.
- **Per-rule contact correlation**: Rejected because Apple iCloud CardDAV stores all contacts in a single address book with multi-group membership; per-rule tracking would duplicate contacts in Google.

## Consequences

- Deleting a Sync Rule preserves synced Google items by default, offering cleanup only via an explicit opt-in checkbox in the confirmation dialog.
- The contact correlation table is keyed per Profile (not per Sync Rule), with group memberships reconciled as Google Contact Labels.
