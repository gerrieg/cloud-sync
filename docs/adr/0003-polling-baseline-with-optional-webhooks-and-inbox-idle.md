---
status: accepted
---

# Polling Baseline with Optional Webhooks and Single-Folder IMAP IDLE

Real-time triggers are treated as latency optimizations over a polling baseline rather than sole delivery mechanisms. Google Calendar `events.watch` webhooks are enabled only when `PUBLIC_BASE_URL` is configured, with automatic `syncToken` polling as a continuous fallback; for iCloud Mail, each active Profile maintains at most one persistent IMAP `IDLE` connection pinned to `INBOX` while all other subscribed folders rely on lightweight periodic `STATUS`/`UIDNEXT` polling.

## Considered Options

- **Webhooks-only for Google Calendar**: Rejected because missed notifications, expired channels, or local deployments without a public HTTPS URL would silently stall Google-to-Apple sync.
- **One IMAP `IDLE` connection per subscribed mail folder**: Rejected because IMAP `IDLE` monitors only a single selected mailbox per connection, and Apple iCloud enforces strict concurrent-connection caps shared with the user's Apple devices.

## Consequences

- The container works identically behind a public reverse proxy (sub-3-second latency for Google Calendar and `INBOX` mail) and in local or webhook-degraded setups without separate code paths.
- Non-`INBOX` mail folders have 30–60 second sync latency by design in exchange for staying within iCloud's IMAP connection limits.
