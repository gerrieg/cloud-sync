# Cloud Sync

Synchronizes calendars, contacts, and email between Apple iCloud and Google for one or more independent account pairs.

## Language

**Profile**:
An isolated pairing of one Apple iCloud account and one Google account, owning its own sync rules, correlation state, and sync history.
_Avoid_: User, account, tenant

**Sync Rule**:
A configured pairing between one Apple container (calendar, contact group, or mail folder) and one Google container (calendar, contact label, or Gmail label), including its direction and domain-specific options.
_Avoid_: Mapping, sync config, link

**Synced Item**:
The correlation record tying a single Apple entity (event, contact, or email) to its Google counterpart within a Profile, along with the state needed to detect changes on either side. Events are tracked per Sync Rule; contacts and emails are deduplicated profile-wide across Sync Rules.
_Avoid_: Mapping, shadow record, cache entry

**One-Way Sync**:
A change-driven sync mode (`Apple → Google`) that propagates changes only from Apple and ignores manual edits or deletions made on Google until Apple changes again.
_Avoid_: Strict mirror

**Apple Master**:
The conflict-resolution rule for bidirectional sync under which Apple iCloud always wins when both sides changed the same item since the last sync, while uncontested Google changes and deletions still propagate back to Apple.
_Avoid_: Read-only Google, one-way fallback

**Delete Guard**:
A safety threshold that halts a sync run when planned deletions exceed a configured count or share of tracked items, requiring explicit admin confirmation before applying them.
_Avoid_: Soft delete, trash mode

