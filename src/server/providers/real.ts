import { google } from 'googleapis';
import { ImapFlow } from 'imapflow';
import { createDAVClient } from 'tsdav';
import type { AppleConnectionReport, ProtocolCheckResult } from '../../shared/profile.js';
import { isInvalidGrant } from './google-errors.js';
import { createRealAppleCalendars, createRealGoogleCalendars } from './real-calendar.js';
import { createRealAppleContacts, createRealGoogleContacts } from './real-contacts.js';
import {
  GMAIL_IMPORT_MIN_INTERVAL_MS,
  ICLOUD_IMAP_HOST,
  ICLOUD_IMAP_PORT,
  createRealAppleMail,
  createRealGoogleMail,
} from './real-mail.js';
import { createGoogleThrottle } from './google-throttle.js';
import { createRateLimiter } from './rate-limiter.js';
import {
  GOOGLE_INVALID_GRANT,
  GoogleAuthError,
  type AppleCredentials,
  type GoogleTokens,
  type SyncProviders,
  type SyncProvidersFactory,
} from './types.js';

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';
const ICLOUD_CARDDAV_URL = 'https://contacts.icloud.com';
const CHECK_TIMEOUT_MS = 15_000;

const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/gmail.modify',
] as const;

export interface RealProvidersConfig {
  readonly googleClientId: string;
  readonly googleClientSecret: string;
  /** Called whenever a Google OAuth2 client refreshes tokens for a Profile so they can be persisted. */
  readonly onGoogleTokensRefreshed?: (profileId: string, tokens: GoogleTokens) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Unknown error';
}

/**
 * Runs one connectivity check with a deadline. On timeout the signal aborts the underlying
 * request/socket instead of letting it linger in the background.
 */
async function runCheck(
  check: (signal: AbortSignal) => Promise<void>,
): Promise<ProtocolCheckResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('Timed out')), { once: true });
  });
  try {
    await Promise.race([check(controller.signal), timedOut]);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

async function checkDav(
  serverUrl: string,
  accountType: 'caldav' | 'carddav',
  credentials: AppleCredentials,
  signal: AbortSignal,
): Promise<void> {
  const client = await createDAVClient({
    serverUrl,
    credentials: { username: credentials.appleId, password: credentials.appPassword },
    authMethod: 'Basic',
    defaultAccountType: accountType,
    fetchOptions: { signal },
  });
  if (accountType === 'caldav') {
    await client.fetchCalendars();
  } else {
    await client.fetchAddressBooks();
  }
}

async function checkImap(credentials: AppleCredentials, signal: AbortSignal): Promise<void> {
  const client = new ImapFlow({
    host: ICLOUD_IMAP_HOST,
    port: ICLOUD_IMAP_PORT,
    secure: true,
    auth: { user: credentials.appleId, pass: credentials.appPassword },
    logger: false,
  });
  // imapflow emits connection errors; without a listener they would crash the process
  client.on('error', () => undefined);
  signal.addEventListener('abort', () => client.close(), { once: true });
  try {
    await client.connect();
    await client.logout();
  } catch (error) {
    client.close();
    throw error;
  }
}

function createOAuthClient(config: RealProvidersConfig, redirectUri: string) {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, redirectUri);
}

/** The Google People API asks for about one request per second per user. */
const PEOPLE_API_MIN_INTERVAL_MS = 1000;

export function createRealSyncProviders(config: RealProvidersConfig): SyncProvidersFactory {
  // One limiter per Profile, shared by all runs, so overlapping requests still respect the quota
  const limiterPool = (minIntervalMs: number) => {
    const limiters = new Map<string, ReturnType<typeof createRateLimiter>>();
    return (profileId: string) => {
      let limiter = limiters.get(profileId);
      if (!limiter) {
        limiter = createRateLimiter(minIntervalMs);
        limiters.set(profileId, limiter);
      }
      return limiter;
    };
  };
  // Calendar calls of a Profile queue behind one adaptive throttle that also repeats rate-limited calls
  const calendarThrottles = new Map<string, ReturnType<typeof createGoogleThrottle>>();
  const calendarThrottleFor = (profileId: string) => {
    let throttle = calendarThrottles.get(profileId);
    if (!throttle) {
      throttle = createGoogleThrottle();
      calendarThrottles.set(profileId, throttle);
    }
    return throttle;
  };
  const peopleLimiterFor = limiterPool(PEOPLE_API_MIN_INTERVAL_MS);
  const gmailImportLimiterFor = limiterPool(GMAIL_IMPORT_MIN_INTERVAL_MS);
  // One Apple mail adapter per Profile (invalidated when credentials change), so `pollMail` and
  // the `syncNow` it triggers share the same serialized IMAP connection instead of opening two.
  const appleMailPool = new Map<string, { readonly key: string; readonly mail: SyncProviders['apple']['mail'] }>();
  const appleMailFor = (profileId: string, credentials: AppleCredentials | null): SyncProviders['apple']['mail'] => {
    if (!credentials) {
      appleMailPool.delete(profileId);
      return createRealAppleMail(null);
    }
    const key = `${credentials.appleId}\0${credentials.appPassword}`;
    const cached = appleMailPool.get(profileId);
    if (cached && cached.key === key) {
      return cached.mail;
    }
    const mail = createRealAppleMail(credentials);
    appleMailPool.set(profileId, { key, mail });
    return mail;
  };

  return (context): SyncProviders => {
    const onTokensRefreshed = config.onGoogleTokensRefreshed
      ? (tokens: GoogleTokens) => config.onGoogleTokensRefreshed?.(context.profileId, tokens)
      : undefined;

    return {
      apple: {
        async testConnection(): Promise<AppleConnectionReport> {
          const credentials = context.apple;
          if (!credentials) {
            const missing: ProtocolCheckResult = { ok: false, error: 'No Apple credentials configured' };
            return { caldav: missing, carddav: missing, imap: missing };
          }
          const [caldav, carddav, imap] = await Promise.all([
            runCheck((signal) => checkDav(ICLOUD_CALDAV_URL, 'caldav', credentials, signal)),
            runCheck((signal) => checkDav(ICLOUD_CARDDAV_URL, 'carddav', credentials, signal)),
            runCheck((signal) => checkImap(credentials, signal)),
          ]);
          return { caldav, carddav, imap };
        },
        calendars: createRealAppleCalendars(context.apple),
        contacts: createRealAppleContacts(context.apple),
        mail: appleMailFor(context.profileId, context.apple),
      },
      google: {
        calendars: createRealGoogleCalendars(
          config,
          context.googleTokens,
          calendarThrottleFor(context.profileId),
          undefined,
          onTokensRefreshed,
        ),
        contacts: createRealGoogleContacts(
          config,
          context.googleTokens,
          peopleLimiterFor(context.profileId),
          undefined,
          onTokensRefreshed,
        ),
        mail: createRealGoogleMail(
          config,
          context.googleTokens,
          gmailImportLimiterFor(context.profileId),
          undefined,
          onTokensRefreshed,
        ),
        buildAuthUrl({ redirectUri, state }) {
          return createOAuthClient(config, redirectUri).generateAuthUrl({
            access_type: 'offline',
            prompt: 'consent',
            include_granted_scopes: true,
            scope: [...GOOGLE_SCOPES],
            state,
          });
        },
        async exchangeCode({ code, redirectUri }) {
          try {
            const { tokens } = await createOAuthClient(config, redirectUri).getToken(code);
            if (!tokens.refresh_token) {
              throw new GoogleAuthError('missing_refresh_token', 'Google returned no refresh token');
            }
            return {
              refresh_token: tokens.refresh_token,
              access_token: tokens.access_token ?? undefined,
              expiry_date: tokens.expiry_date ?? undefined,
              scope: tokens.scope,
            };
          } catch (error) {
            if (error instanceof GoogleAuthError) {
              throw error;
            }
            if (isInvalidGrant(error)) {
              throw new GoogleAuthError(GOOGLE_INVALID_GRANT, describeError(error));
            }
            throw error;
          }
        },
      },
    };
  };
}
