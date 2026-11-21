import { google } from 'googleapis';
import { ImapFlow } from 'imapflow';
import { createDAVClient } from 'tsdav';
import type { AppleConnectionReport, ProtocolCheckResult } from '../../shared/profile.js';
import { createRealAppleCalendars, createRealGoogleCalendars } from './real-calendar.js';
import {
  GOOGLE_INVALID_GRANT,
  GoogleAuthError,
  type AppleCredentials,
  type SyncProviders,
  type SyncProvidersFactory,
} from './types.js';

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com';
const ICLOUD_CARDDAV_URL = 'https://contacts.icloud.com';
const ICLOUD_IMAP_HOST = 'imap.mail.me.com';
const ICLOUD_IMAP_PORT = 993;
const CHECK_TIMEOUT_MS = 15_000;

export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts',
  'https://www.googleapis.com/auth/gmail.modify',
] as const;

export interface RealProvidersConfig {
  readonly googleClientId: string;
  readonly googleClientSecret: string;
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

function isInvalidGrant(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const responseError = (error as { response?: { data?: { error?: unknown } } }).response?.data?.error;
  return (
    responseError === GOOGLE_INVALID_GRANT ||
    (error instanceof Error && error.message.includes(GOOGLE_INVALID_GRANT))
  );
}

function createOAuthClient(config: RealProvidersConfig, redirectUri: string) {
  return new google.auth.OAuth2(config.googleClientId, config.googleClientSecret, redirectUri);
}

export function createRealSyncProviders(config: RealProvidersConfig): SyncProvidersFactory {
  return (context): SyncProviders => ({
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
    },
    google: {
      calendars: createRealGoogleCalendars(config, context.googleTokens),
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
  });
}
