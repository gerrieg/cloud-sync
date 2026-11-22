import { useEffect, useState } from 'react';
import { getProfileStatus, type ProfileStatusDto } from '../lib/profiles-api.js';
import { StatusBadges } from './StatusBadges.js';

const REFRESH_INTERVAL_MS = 5_000;

/** Live state of one Profile's INBOX IDLE connection and Google Calendar mode. */
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

  return status ? <StatusBadges status={status} /> : null;
}
