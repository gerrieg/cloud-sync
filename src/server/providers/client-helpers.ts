import { google, type Auth } from 'googleapis';
import { createDAVClient } from 'tsdav';
import type { AppleCredentials, GoogleTokens } from './types.js';

export interface GoogleClientConfig {
  readonly googleClientId: string;
  readonly googleClientSecret: string;
}

export type DavClient = Awaited<ReturnType<typeof createDAVClient>>;

/** One DAV client per adapter: account discovery happens once, not before every call. */
export function createDavSession(
  serverUrl: string,
  accountType: 'caldav' | 'carddav',
  credentials: AppleCredentials | null,
): () => Promise<DavClient> {
  let session: Promise<DavClient> | undefined;
  return async () => {
    if (!credentials) {
      throw new Error('No Apple credentials configured');
    }
    session ??= createDAVClient({
      serverUrl,
      credentials: { username: credentials.appleId, password: credentials.appPassword },
      authMethod: 'Basic',
      defaultAccountType: accountType,
    }).catch((error: unknown) => {
      session = undefined;
      throw error;
    });
    return session;
  };
}

/** One Google API client per adapter: it refreshes the expired access token once, not before every call. */
export function createGoogleClient<T>(
  config: GoogleClientConfig,
  tokens: GoogleTokens | null,
  build: (auth: Auth.OAuth2Client) => T,
  makeClient?: () => T,
  onTokensRefreshed?: (tokens: GoogleTokens) => void,
): () => T {
  let realClient: T | undefined;
  return () => {
    if (makeClient) {
      return makeClient();
    }
    if (!tokens) {
      throw new Error('Google account is not connected');
    }
    if (!realClient) {
      const auth = new google.auth.OAuth2(config.googleClientId, config.googleClientSecret);
      let current: GoogleTokens = { ...tokens };
      auth.setCredentials({ ...current });
      if (onTokensRefreshed) {
        auth.on('tokens', (refreshed) => {
          if (!refreshed.access_token && !refreshed.refresh_token) {
            return;
          }
          current = {
            refresh_token: refreshed.refresh_token ?? current.refresh_token,
            access_token: refreshed.access_token ?? current.access_token,
            expiry_date: refreshed.expiry_date ?? current.expiry_date,
            scope: refreshed.scope ?? current.scope,
          };
          onTokensRefreshed(current);
        });
      }
      realClient = build(auth);
    }
    return realClient;
  };
}
