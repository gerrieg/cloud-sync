/** Contracts shared by the server API and the React client. */

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

/** State of the persistent IMAP `IDLE` connection that watches a Profile's INBOX. */
export type MailIdleState = 'connected' | 'reconnecting' | 'paused' | 'disconnected';

/**
 * How Google → Apple calendar changes reach the app: pushed by `webhook`, or found by `polling`
 * (no public URL, or the channel is missing, degraded or expired); `inactive` without work to do.
 */
export type GoogleCalendarMode = 'webhook' | 'polling' | 'inactive';

/** Response of `GET /api/profiles/:id/status`: how the real-time triggers of a Profile are doing. */
export interface ProfileStatusDto {
  readonly mailIdle: MailIdleState;
  readonly googleCalendar: GoogleCalendarMode;
}

/** Body of `PATCH /api/profiles/:id`. Apple credentials must be sent together. */
export interface ProfileUpdate {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly appleId?: string;
  readonly appleAppPassword?: string;
}

export type ProtocolCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface AppleConnectionReport {
  readonly caldav: ProtocolCheckResult;
  readonly carddav: ProtocolCheckResult;
  readonly imap: ProtocolCheckResult;
}

/** Response of `POST /api/profiles/:id/test-apple`. */
export interface AppleTestReport extends AppleConnectionReport {
  readonly ok: boolean;
}

/** Outcome the Google OAuth callback reports to the UI via `/?profile=<id>&google=<outcome>`. */
export const GOOGLE_LINK_OUTCOMES = ['connected', 'invalid_grant', 'error'] as const;
export type GoogleLinkOutcome = (typeof GOOGLE_LINK_OUTCOMES)[number];

export function parseGoogleLinkOutcome(value: string | null | undefined): GoogleLinkOutcome | null {
  return GOOGLE_LINK_OUTCOMES.find((outcome) => outcome === value) ?? null;
}
