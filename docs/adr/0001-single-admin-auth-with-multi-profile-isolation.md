---
status: accepted
---

# Single-Admin Env Auth with Multi-Profile Isolation

Although Cloud Sync manages credentials and sync state for multiple independent Profiles (such as household members), the web UI is protected by a single environment-configured admin login (`USER_NAME`, bcrypt `USER_PASSWORD_HASH`, and an optional `TOTP_SECRET` with single-use step tracking and SQLite-persisted lockout) rather than per-user accounts and RBAC. All Profiles also share a single environment-configured Google OAuth client (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, set to "In Production" to avoid 7-day token expiry) and `ENCRYPTION_KEY`, while external callback endpoints (`/webhooks/google/:profileId` and `/api/trigger-sync/:profileId`) bypass the session cookie and self-authenticate via dedicated per-channel or per-Profile tokens.

## Considered Options

- **Multi-user accounts with per-user login and RBAC**: Rejected because household self-hosting does not need user lifecycle management or permission matrices, and adding them expands the auth attack surface.
- **No app-level auth (rely on LAN/VPN or reverse-proxy auth)**: Rejected because the container is exposed over public HTTPS for Google webhooks and OAuth callbacks.

## Consequences

- Leaving `TOTP_SECRET` empty switches the second factor off: the login accepts username and password only, and the login screen learns this from the public `GET /api/auth/config`. This trades security for convenience and is meant for deployments that are not publicly reachable or are protected elsewhere.
- There is no `users` table; all domain tables isolate state by `profile_id`.
- Every new external endpoint must explicitly choose between session auth and self-authentication so webhook and shortcut callers are never redirected to the login page.
