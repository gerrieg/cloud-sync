import { useEffect, useState } from 'react';
import type { GoogleCalendarMode, MailIdleState } from '../../shared/profile.js';
import { getProfileStatus, type ProfileStatusDto } from '../lib/profiles-api.js';

const REFRESH_INTERVAL_MS = 5_000;

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

/** Live state of the INBOX IMAP IDLE connection and of how Google Calendar changes arrive. */
export function ProfileStatusBadges({ profileId }: { profileId: string }) {
  const [status, setStatus] = useState<ProfileStatusDto | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(null);
    const refresh = () => {
      getProfileStatus(profileId)
        .then((loaded) => {
          if (active) {
            setStatus(loaded);
          }
        })
        // A failed refresh keeps showing the last known state
        .catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, REFRESH_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [profileId]);

  if (!status) {
    return null;
  }
  return (
    <>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${MAIL_IDLE_CLASS[status.mailIdle]}`}>
        Mail IDLE: {status.mailIdle}
      </span>
      <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${CALENDAR_CLASS[status.googleCalendar]}`}>
        Google Calendar: {CALENDAR_LABEL[status.googleCalendar]}
      </span>
    </>
  );
}
