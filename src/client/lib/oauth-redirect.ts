import { parseGoogleLinkOutcome, type GoogleLinkOutcome } from '../../shared/profile.js';

export interface OAuthRedirect {
  readonly profileId: string | null;
  readonly outcome: GoogleLinkOutcome | null;
}

/** Reads the result of the Google OAuth callback redirect (`/?profile=<id>&google=<outcome>`). */
export function readOAuthRedirect(search: string): OAuthRedirect {
  const params = new URLSearchParams(search);
  return {
    profileId: params.get('profile'),
    outcome: parseGoogleLinkOutcome(params.get('google')),
  };
}
