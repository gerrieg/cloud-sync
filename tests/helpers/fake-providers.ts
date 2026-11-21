import type { AppleConnectionReport, ProtocolCheckResult } from '../../src/shared/profile.js';
import {
  GoogleAuthError,
  type GoogleTokens,
  type SyncProviders,
  type SyncProvidersContext,
  type SyncProvidersFactory,
} from '../../src/server/providers/types.js';

type ProtocolName = 'caldav' | 'carddav' | 'imap';

interface FakeAppleAccount {
  password: string;
  failing: Map<ProtocolName, string>;
}

/**
 * Stateful in-memory stand-in for the external Apple/Google services.
 * Tests configure the "remote world" here; the app only sees it through SyncProviders.
 */
export class FakeSyncProviders {
  private readonly appleAccounts = new Map<string, FakeAppleAccount>();
  private readonly googleCodes = new Map<string, GoogleTokens>();
  private readonly invalidGrantCodes = new Set<string>();

  /** Every context the app instantiated providers with (decrypted, as the adapters would see it). */
  readonly contexts: SyncProvidersContext[] = [];

  addAppleAccount(appleId: string, password: string): void {
    this.appleAccounts.set(appleId, { password, failing: new Map() });
  }

  failAppleProtocol(appleId: string, protocol: ProtocolName, error: string): void {
    this.appleAccounts.get(appleId)?.failing.set(protocol, error);
  }

  issueGoogleCode(code: string, tokens: GoogleTokens): void {
    this.googleCodes.set(code, tokens);
  }

  rejectGoogleCodeWithInvalidGrant(code: string): void {
    this.invalidGrantCodes.add(code);
  }

  readonly factory: SyncProvidersFactory = (context) => {
    this.contexts.push(context);
    return this.build(context);
  };

  private build(context: SyncProvidersContext): SyncProviders {
    return {
      apple: {
        testConnection: async (): Promise<AppleConnectionReport> => {
          const credentials = context.apple;
          const account = credentials ? this.appleAccounts.get(credentials.appleId) : undefined;
          const check = (protocol: ProtocolName): ProtocolCheckResult => {
            if (!account || account.password !== credentials?.appPassword) {
              return { ok: false, error: 'Authentication failed' };
            }
            const failure = account.failing.get(protocol);
            return failure ? { ok: false, error: failure } : { ok: true };
          };
          return { caldav: check('caldav'), carddav: check('carddav'), imap: check('imap') };
        },
      },
      google: {
        buildAuthUrl: ({ redirectUri, state }) =>
          `https://accounts.google.test/auth?${new URLSearchParams({
            redirect_uri: redirectUri,
            state,
            access_type: 'offline',
          }).toString()}`,
        exchangeCode: async ({ code }) => {
          if (this.invalidGrantCodes.has(code)) {
            throw new GoogleAuthError('invalid_grant', 'Bad Request');
          }
          const tokens = this.googleCodes.get(code);
          if (!tokens) {
            throw new GoogleAuthError('invalid_grant', 'Unknown authorization code');
          }
          this.googleCodes.delete(code);
          return tokens;
        },
      },
    };
  }
}
