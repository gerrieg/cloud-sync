import type { GoogleCalendarMode, MailIdleState, ProfileStatusDto } from '../../shared/profile.js';

const MAIL_IDLE_CLASS: Record<MailIdleState, string> = {
  connected: 'bg-emerald-100 text-emerald-800',
  reconnecting: 'bg-amber-100 text-amber-800',
  paused: 'bg-slate-100 text-slate-700',
  disconnected: 'bg-slate-100 text-slate-700',
};

const CALENDAR_LABEL: Record<GoogleCalendarMode, string> = {
  webhook: 'webhook',
  polling: 'polling fallback',
  inactive: 'inactive',
};

const CALENDAR_CLASS: Record<GoogleCalendarMode, string> = {
  webhook: 'bg-emerald-100 text-emerald-800',
  polling: 'bg-amber-100 text-amber-800',
  inactive: 'bg-slate-100 text-slate-700',
};

/** The INBOX IMAP IDLE state and the way Google Calendar changes arrive, as two badges. */
export function StatusBadges({ status }: { status: ProfileStatusDto }) {
  return (
    <>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${MAIL_IDLE_CLASS[status.mailIdle]}`}>
        Mail IDLE: {status.mailIdle}
      </span>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap ${CALENDAR_CLASS[status.googleCalendar]}`}>
        Google Calendar: {CALENDAR_LABEL[status.googleCalendar]}
      </span>
    </>
  );
}
